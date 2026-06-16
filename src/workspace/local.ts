import { spawn } from "node:child_process";
import { readdir, readFile as fsReadFile, writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Workspace } from "./types.js";

const FORCE_KILL_MS = 2000;

export function createLocalWorkspace(): Workspace {
  const workspace: Workspace = {
    kind: "local",

    exec(command, cwd, opts) {
      return new Promise((resolvePromise, reject) => {
        const child = spawn(command, {
          cwd,
          shell: true,
          env: { ...process.env, ...opts.env },
        });

        let settled = false;
        let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

        const finish = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolvePromise({ exitCode });
        };

        const terminate = () => {
          child.kill("SIGTERM");
          forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), FORCE_KILL_MS);
        };

        const onAbort = () => terminate();

        const cleanup = () => {
          opts.signal?.removeEventListener("abort", onAbort);
          if (forceKillTimer) clearTimeout(forceKillTimer);
        };

        if (opts.signal?.aborted) terminate();
        opts.signal?.addEventListener("abort", onAbort, { once: true });

        if (opts.timeout && opts.timeout > 0) {
          const timer = setTimeout(() => terminate(), opts.timeout * 1000);
          child.on("close", () => clearTimeout(timer));
        }

        child.stdout.on("data", (chunk: Buffer) => opts.onData(chunk));
        child.stderr.on("data", (chunk: Buffer) => opts.onData(chunk));
        child.on("close", (code) => finish(code));
        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          cleanup();
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

    async dispose() {},
  };
  return workspace;
}
