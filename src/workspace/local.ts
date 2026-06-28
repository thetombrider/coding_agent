import { spawn } from "node:child_process";
import {
  readdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir,
  stat as fsStat,
  unlink,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  BackgroundProcessRegistry,
  sessionJobsDir,
} from "./background-jobs.js";
import {
  killProcessTree,
  trackDetachedChildPid,
  untrackDetachedChildPid,
  waitForChildProcess,
} from "./child-process.js";
import type { Workspace } from "./types.js";

const FORCE_KILL_MS = 2000;

export interface LocalWorkspaceOptions {
  sessionId?: string;
}

export interface LocalWorkspace extends Workspace {
  backgroundJobs: BackgroundProcessRegistry;
}

export function createLocalWorkspace(opts?: LocalWorkspaceOptions): LocalWorkspace {
  const jobsDir = opts?.sessionId
    ? sessionJobsDir(opts.sessionId)
    : join(tmpdir(), `orin-jobs-${randomUUID()}`);
  const registry = new BackgroundProcessRegistry(jobsDir);

  const workspace: LocalWorkspace = {
    kind: "local",
    backgroundJobs: registry,

    exec(command, cwd, opts) {
      return new Promise((resolvePromise, reject) => {
        const child = spawn(command, {
          cwd,
          shell: true,
          detached: true,
          env: { ...process.env, ...opts.env },
        });

        const pid = child.pid;
        if (pid !== undefined) trackDetachedChildPid(pid);

        let settled = false;
        let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        let forwarded = 0;
        let truncated = false;

        const finish = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (pid !== undefined) untrackDetachedChildPid(pid);
          resolvePromise({ exitCode, truncated, timedOut });
        };

        const killTree = (signal: NodeJS.Signals) => {
          if (pid === undefined) return;
          try {
            process.kill(-pid, signal);
          } catch {
            try {
              child.kill(signal);
            } catch {
              // already exited
            }
          }
        };

        const terminate = () => {
          killTree("SIGTERM");
          forceKillTimer ??= setTimeout(() => killTree("SIGKILL"), FORCE_KILL_MS);
        };

        const onAbort = () => terminate();

        const cleanup = () => {
          opts.signal?.removeEventListener("abort", onAbort);
          if (forceKillTimer) clearTimeout(forceKillTimer);
          if (timeoutTimer) clearTimeout(timeoutTimer);
        };

        if (opts.signal?.aborted) terminate();
        opts.signal?.addEventListener("abort", onAbort, { once: true });

        if (opts.timeout && opts.timeout > 0) {
          timeoutTimer = setTimeout(() => {
            timedOut = true;
            terminate();
          }, opts.timeout * 1000);
        }

        const onChunk = (chunk: Buffer) => {
          if (truncated) return;
          const max = opts.maxBuffer;
          if (max === undefined) {
            opts.onData(chunk);
            return;
          }
          const remaining = max - forwarded;
          if (chunk.length < remaining) {
            forwarded += chunk.length;
            opts.onData(chunk);
            return;
          }
          if (remaining > 0) opts.onData(chunk.subarray(0, remaining));
          forwarded = max;
          truncated = true;
          terminate();
        };

        child.stdout?.on("data", onChunk);
        child.stderr?.on("data", onChunk);

        void waitForChildProcess(child)
          .then((code) => finish(code))
          .catch((err) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (pid !== undefined) untrackDetachedChildPid(pid);
            reject(err);
          });
      });
    },

    readFile(path) {
      return fsReadFile(path, "utf8");
    },

    async writeFile(path, content) {
      await mkdir(dirname(path), { recursive: true });
      await fsWriteFile(path, content, "utf8");
    },

    async list(path) {
      return readdir(path);
    },

    async stat(path) {
      try {
        const s = await fsStat(path);
        return { isFile: s.isFile(), isDirectory: s.isDirectory() };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },

    async deleteFile(path) {
      await unlink(path);
    },

    async move(source, destination) {
      await rename(source, destination);
    },

    async dispose() {
      await registry.dispose();
    },
  };

  return workspace;
}

export { killProcessTree };
