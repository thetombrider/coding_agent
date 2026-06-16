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
    dispose: async () => {
      await sbx.kill();
    },
  };
}

type E2BSandbox = Awaited<ReturnType<typeof import("e2b").Sandbox.create>>;

async function execE2B(
  sbx: E2BSandbox,
  command: string,
  cwd: string,
  opts: WorkspaceExecOptions,
): Promise<{ exitCode: number | null }> {
  const runOpts = {
    cwd,
    envs: opts.env,
    timeoutMs: opts.timeout ? opts.timeout * 1000 : undefined,
    onStdout: (d: string) => opts.onData(Buffer.from(d)),
    onStderr: (d: string) => opts.onData(Buffer.from(d)),
  };

  if (opts.signal) {
    const handle = await sbx.commands.run(command, { ...runOpts, background: true });
    const abort = () => {
      void handle.kill().catch(() => {});
    };
    opts.signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await handle.wait();
      return { exitCode: result.exitCode };
    } finally {
      opts.signal.removeEventListener("abort", abort);
    }
  }

  const r = await sbx.commands.run(command, runOpts);
  return { exitCode: r.exitCode };
}
