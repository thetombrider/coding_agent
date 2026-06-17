import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CopyMethod = "osc52" | "pbcopy" | "wl-copy" | "xclip" | "clip.exe" | "file";

export interface CopyResult {
  ok: boolean;
  method?: CopyMethod;
  path?: string;
  error?: string;
  lineCount?: number;
}

export interface CopyCommand {
  bin: string;
  args: string[];
}

export interface SpawnFn {
  (
    command: string[],
    options: { stdin: "pipe"; stdout: "ignore"; stderr: "ignore" },
  ): {
    stdin?: { write(data: string): void; end(): void };
    exited: Promise<number>;
  };
}

export interface ClipboardDeps {
  isTty?: boolean;
  writeStdout?: (data: string) => void;
  spawn?: SpawnFn;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  writeTempFile?: (text: string) => string;
  /** When set, skip OSC 52 and use platform/file fallbacks only. */
  skipOsc52?: boolean;
}

export function encodeOsc52Payload(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

export function buildOsc52Sequence(text: string): string {
  return `\x1b]52;c;${encodeOsc52Payload(text)}\x07`;
}

export function resolveCopyCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): CopyCommand | null {
  if (platform === "darwin") return { bin: "pbcopy", args: [] };
  if (platform === "win32") return { bin: "clip.exe", args: [] };
  if (platform === "linux") {
    if (env.WAYLAND_DISPLAY) return { bin: "wl-copy", args: [] };
    return { bin: "xclip", args: ["-selection", "clipboard"] };
  }
  return null;
}

function defaultWriteTempFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "orin-clip-"));
  const path = join(dir, "clipboard.txt");
  writeFileSync(path, text, "utf8");
  return path;
}

async function spawnCopy(text: string, command: CopyCommand): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = nodeSpawn(command.bin, command.args, {
        stdio: ["pipe", "ignore", "ignore"],
      });
      proc.stdin?.write(text, "utf8");
      proc.stdin?.end();
      proc.once("error", () => resolve(false));
      proc.once("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

async function spawnCopyWithFn(
  text: string,
  command: CopyCommand,
  spawnFn: SpawnFn,
): Promise<boolean> {
  try {
    const proc = spawnFn([command.bin, ...command.args], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.stdin?.write(text);
    proc.stdin?.end();
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export async function copyToClipboard(
  text: string,
  deps: ClipboardDeps = {},
): Promise<CopyResult> {
  const lineCount = text.length === 0 ? 0 : text.split("\n").length;
  if (!text) return { ok: false, error: "nothing to copy", lineCount: 0 };

  const isTty = deps.isTty ?? process.stdout.isTTY;
  const writeStdout = deps.writeStdout ?? ((data: string) => process.stdout.write(data));

  if (!deps.skipOsc52 && isTty) {
    try {
      writeStdout(buildOsc52Sequence(text));
      return { ok: true, method: "osc52", lineCount };
    } catch {
      // fall through
    }
  }

  const command = resolveCopyCommand(deps.platform, deps.env);
  if (command) {
    const copied = deps.spawn
      ? await spawnCopyWithFn(text, command, deps.spawn)
      : await spawnCopy(text, command);
    if (copied) {
      const method =
        command.bin === "pbcopy"
          ? "pbcopy"
          : command.bin === "wl-copy"
            ? "wl-copy"
            : command.bin === "clip.exe"
              ? "clip.exe"
              : "xclip";
      return { ok: true, method, lineCount };
    }
  }

  try {
    const writeTempFile = deps.writeTempFile ?? defaultWriteTempFile;
    const path = writeTempFile(text);
    return { ok: true, method: "file", path, lineCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, lineCount };
  }
}

export function formatCopyStatus(result: CopyResult): string {
  if (result.ok && result.method === "file" && result.path) {
    return `Copied to ${result.path} (${result.lineCount ?? 0} lines)`;
  }
  if (result.ok) {
    return `Copied to clipboard (${result.lineCount ?? 0} lines)`;
  }
  return "Clipboard unavailable in this terminal — see ~/.orin/sessions/*.jsonl";
}
