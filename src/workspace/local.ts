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
import { dirname } from "node:path";
import type { Workspace } from "./types.js";

const FORCE_KILL_MS = 2000;

export function createLocalWorkspace(): Workspace {
  const workspace: Workspace = {
    kind: "local",

    exec(command, cwd, opts) {
      return new Promise((resolvePromise, reject) => {
        // `detached` puts the shell in its own process group so we can signal the
        // whole tree. Killing only the shell's pid leaves grandchildren (e.g. a
        // `yes` behind `sh -c`) alive and holding the stdout pipe open, so the
        // `close` event never fires and the command never resolves.
        const child = spawn(command, {
          cwd,
          shell: true,
          detached: true,
          env: { ...process.env, ...opts.env },
        });

        let settled = false;
        let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
        let forwarded = 0;
        let truncated = false;

        const finish = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolvePromise({ exitCode, truncated });
        };

        // Signal the child's whole process group (negative pid). Falls back to the
        // bare pid if the group is already gone or the platform rejects it.
        const killTree = (signal: NodeJS.Signals) => {
          if (child.pid === undefined) return;
          try {
            process.kill(-child.pid, signal);
          } catch {
            try {
              child.kill(signal);
            } catch {
              // already exited — nothing to signal
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
        };

        if (opts.signal?.aborted) terminate();
        opts.signal?.addEventListener("abort", onAbort, { once: true });

        if (opts.timeout && opts.timeout > 0) {
          const timer = setTimeout(() => terminate(), opts.timeout * 1000);
          child.on("close", () => clearTimeout(timer));
        }

        // Forward output, but stop and kill the child once it exceeds maxBuffer.
        // A data listener keeps the pipe in flowing mode (so it is always drained
        // and never deadlocks), while the byte cap bounds memory and context for
        // a runaway command producing unbounded output (#146).
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

        child.stdout.on("data", onChunk);
        child.stderr.on("data", onChunk);
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

    async dispose() {},
  };
  return workspace;
}
