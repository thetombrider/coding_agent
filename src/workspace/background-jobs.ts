import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, open, readFile, stat as fsStat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "./child-process.js";

export type BackgroundJobStatus = "running" | "exited" | "killed";

export interface BackgroundJob {
  id: string;
  command: string;
  pid?: number;
  startedAt: number;
  status: BackgroundJobStatus;
  outputPath: string;
  exitCode?: number | null;
  /** Recent output kept in memory for fast tail before log flush. */
  recentOutput: string;
}

export interface StartBackgroundResult {
  jobId: string;
  pid?: number;
  outputTail: string;
  status: BackgroundJobStatus;
}

const DEFAULT_TAIL_BYTES = 8_000;

export function sessionJobsDir(sessionId: string): string {
  return join(homedir(), ".orin", "sessions", sessionId, "jobs");
}

export class BackgroundProcessRegistry {
  private jobs = new Map<string, BackgroundJob>();
  private children = new Map<string, ChildProcess>();
  private logStreams = new Map<string, WriteStream>();

  constructor(private readonly jobsDir: string) {}

  list(jobId?: string): BackgroundJob[] {
    if (jobId) {
      const job = this.jobs.get(jobId);
      return job ? [job] : [];
    }
    return [...this.jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  async start(
    command: string,
    cwd: string,
    opts?: { waitMs?: number; env?: Record<string, string> },
  ): Promise<StartBackgroundResult> {
    await mkdir(this.jobsDir, { recursive: true });
    const jobId = randomUUID().slice(0, 8);
    const outputPath = join(this.jobsDir, `${jobId}.log`);
    const logStream = createWriteStream(outputPath, { flags: "a" });
    this.logStreams.set(jobId, logStream);

    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts?.env },
    });

    const pid = child.pid;
    if (pid !== undefined) trackDetachedChildPid(pid);

    const job: BackgroundJob = {
      id: jobId,
      command,
      pid,
      startedAt: Date.now(),
      status: "running",
      outputPath,
      recentOutput: "",
    };
    this.jobs.set(jobId, job);
    this.children.set(jobId, child);

    const forward = (chunk: Buffer) => {
      const text = chunk.toString();
      job.recentOutput = appendTail(job.recentOutput, text, DEFAULT_TAIL_BYTES);
      logStream.write(chunk);
    };
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);

    child.on("exit", (code) => {
      untrackDetachedChildPid(pid!);
      this.children.delete(jobId);
      closeLogStream(jobId, this.logStreams);
      const current = this.jobs.get(jobId);
      if (!current || current.status === "killed") return;
      current.status = "exited";
      current.exitCode = code;
    });

    const waitMs = opts?.waitMs ?? 0;
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    const outputTail = job.recentOutput || (await readTail(outputPath));
    const current = this.jobs.get(jobId);
    return { jobId, pid, outputTail, status: current?.status ?? "running" };
  }

  async tail(jobId: string, maxBytes = DEFAULT_TAIL_BYTES): Promise<string> {
    const job = this.jobs.get(jobId);
    if (!job) return "";
    if (job.recentOutput) {
      return job.recentOutput.length > maxBytes
        ? job.recentOutput.slice(-maxBytes)
        : job.recentOutput;
    }
    return readTail(job.outputPath, maxBytes);
  }

  async kill(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status !== "running") return true;

    const child = this.children.get(jobId);
    if (child?.pid !== undefined) {
      killProcessTree(child.pid);
      untrackDetachedChildPid(child.pid);
    } else if (job.pid !== undefined) {
      killProcessTree(job.pid);
      untrackDetachedChildPid(job.pid);
    }

    job.status = "killed";
    job.exitCode = null;
    this.children.delete(jobId);
    closeLogStream(jobId, this.logStreams);
    return true;
  }

  async dispose(): Promise<void> {
    for (const job of [...this.jobs.values()]) {
      if (job.status === "running") {
        await this.kill(job.id);
      }
    }
    for (const stream of this.logStreams.values()) {
      stream.end();
    }
    this.logStreams.clear();
  }
}

function closeLogStream(jobId: string, streams: Map<string, WriteStream>): void {
  const stream = streams.get(jobId);
  if (stream) {
    stream.end();
    streams.delete(jobId);
  }
}

async function readTail(path: string, maxBytes = DEFAULT_TAIL_BYTES): Promise<string> {
  try {
    const s = await fsStat(path);
    if (s.size === 0) return "";
    const start = Math.max(0, s.size - maxBytes);
    const length = s.size - start;
    const handle = await open(path, "r");
    try {
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, start);
      return buf.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendTail(existing: string, chunk: string, maxBytes: number): string {
  const combined = existing + chunk;
  if (combined.length <= maxBytes) return combined;
  return combined.slice(-maxBytes);
}

/** Read a job log by path (for tests with custom dirs). */
export async function readJobLog(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export function getBackgroundRegistry(
  workspace: { backgroundJobs?: BackgroundProcessRegistry },
): BackgroundProcessRegistry | undefined {
  return workspace.backgroundJobs;
}
