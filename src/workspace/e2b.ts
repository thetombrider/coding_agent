import { loadConfig } from "../config/config.js";
import type { Workspace, WorkspaceExecOptions } from "./types.js";

export function getE2BApiKey(): string | undefined {
  return (
    process.env.E2B_API_KEY?.trim()
    || loadConfig().sandbox?.e2b?.apiKey?.trim()
    || undefined
  );
}

export async function createE2BWorkspace(): Promise<Workspace> {
  const apiKey = getE2BApiKey();
  if (!apiKey) {
    throw new Error(
      "E2B_API_KEY is not set. Add it to your environment or ~/.orin/config.json under sandbox.e2b.apiKey",
    );
  }

  const { Sandbox } = await import("e2b");
  const sbx = await Sandbox.create({ apiKey });

  return {
    kind: "e2b",

    async exec(command, cwd, opts) {
      return execE2B(sbx, command, cwd, opts);
    },
    readFile: (p) => sbx.files.read(p),
    async writeFile(p, content) {
      await sbx.files.write(p, content);
    },
    async list(p) {
      const entries = await sbx.files.list(p);
      return entries.map((e) => e.name);
    },
    async stat(p) {
      if (!(await sbx.files.exists(p))) return null;
      // FileType is a string enum ("file" | "dir"); compare as string to avoid
      // a static value import of the e2b module (kept dynamic in createE2BWorkspace).
      const type = (await sbx.files.getInfo(p)).type as string | undefined;
      return { isFile: type === "file", isDirectory: type === "dir" };
    },
    async deleteFile(p) {
      await sbx.files.remove(p);
    },
    async move(source, destination) {
      await sbx.files.rename(source, destination);
    },
    dispose: async () => {
      await sbx.kill();
    },
  };
}

type E2BSandbox = Awaited<ReturnType<typeof import("e2b").Sandbox.create>>;
type E2BCommandHandle = Extract<
  Awaited<ReturnType<E2BSandbox["commands"]["run"]>>,
  { kill: () => Promise<boolean> }
>;

async function execE2B(
  sbx: E2BSandbox,
  command: string,
  cwd: string,
  opts: WorkspaceExecOptions,
): Promise<{ exitCode: number | null; truncated?: boolean }> {
  let forwarded = 0;
  let truncated = false;
  let killOnOverflow: (() => void) | undefined;

  // Mirror the local workspace: forward output until maxBuffer is reached, then
  // stop and kill the command so a runaway process cannot exhaust memory or the
  // context window (#146).
  const forward = (d: string) => {
    if (truncated) return;
    const buf = Buffer.from(d);
    const max = opts.maxBuffer;
    if (max === undefined) {
      opts.onData(buf);
      return;
    }
    const remaining = max - forwarded;
    if (buf.length < remaining) {
      forwarded += buf.length;
      opts.onData(buf);
      return;
    }
    if (remaining > 0) opts.onData(buf.subarray(0, remaining));
    forwarded = max;
    truncated = true;
    killOnOverflow?.();
  };

  const runOpts = {
    cwd,
    envs: opts.env,
    timeoutMs: opts.timeout ? opts.timeout * 1000 : undefined,
    onStdout: forward,
    onStderr: forward,
  };

  if (opts.signal) {
    if (opts.signal.aborted) {
      throw opts.signal.reason ?? new Error("Aborted");
    }

    let handle: E2BCommandHandle | undefined;
    const abort = () => {
      void handle?.kill().catch(() => {});
    };
    opts.signal.addEventListener("abort", abort, { once: true });
    try {
      handle = await sbx.commands.run(command, { ...runOpts, background: true });
      killOnOverflow = abort;
      if (opts.signal.aborted) {
        await handle.kill();
        throw opts.signal.reason ?? new Error("Aborted");
      }
      const result = await handle.wait();
      return { exitCode: result.exitCode, truncated };
    } finally {
      opts.signal.removeEventListener("abort", abort);
    }
  }

  const r = await sbx.commands.run(command, runOpts);
  return { exitCode: r.exitCode, truncated };
}
