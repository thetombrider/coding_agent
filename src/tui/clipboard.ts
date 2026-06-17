import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CopyMethod = "osc52" | "pbcopy" | "wl-copy" | "xclip" | "clip.exe" | "file";
export type PasteMethod = "pbpaste" | "wl-paste" | "xclip" | "powershell" | "file";

export interface CopyResult {
  ok: boolean;
  method?: CopyMethod;
  path?: string;
  error?: string;
  lineCount?: number;
}

export interface ReadResult {
  ok: boolean;
  text?: string;
  method?: PasteMethod;
  error?: string;
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
  /** Test hook: override clipboard read from the resolved paste command. */
  readText?: (command: CopyCommand) => Promise<string | null>;
}

export function encodeOsc52Payload(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

export function buildOsc52Sequence(text: string): string {
  return `\x1b]52;c;${encodeOsc52Payload(text)}\x07`;
}

export function isWsl(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.WSL_DISTRO_NAME || env.WSLENV || env.WSL_INTEROP);
}

export function resolveCopyCommands(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): CopyCommand[] {
  if (platform === "darwin") return [{ bin: "pbcopy", args: [] }];
  if (platform === "win32") return [{ bin: "clip.exe", args: [] }];
  if (platform === "linux") {
    const commands: CopyCommand[] = [];
    if (isWsl(env)) commands.push({ bin: "clip.exe", args: [] });
    if (env.WAYLAND_DISPLAY) commands.push({ bin: "wl-copy", args: [] });
    commands.push({ bin: "xclip", args: ["-selection", "clipboard"] });
    return commands;
  }
  return [];
}

function copyMethodFor(command: CopyCommand): CopyMethod {
  if (command.bin === "pbcopy") return "pbcopy";
  if (command.bin === "wl-copy") return "wl-copy";
  if (command.bin === "clip.exe") return "clip.exe";
  return "xclip";
}

export function resolvePasteCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): CopyCommand | null {
  if (platform === "darwin") return { bin: "pbpaste", args: [] };
  if (platform === "win32") {
    return {
      bin: "powershell",
      args: ["-NoProfile", "-Command", "Get-Clipboard -Raw"],
    };
  }
  if (platform === "linux") {
    if (env.WAYLAND_DISPLAY) return { bin: "wl-paste", args: ["-n"] };
    return { bin: "xclip", args: ["-selection", "clipboard", "-o"] };
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

async function spawnRead(command: CopyCommand): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const proc = nodeSpawn(command.bin, command.args, {
        stdio: ["ignore", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
      proc.once("error", () => resolve(null));
      proc.once("close", (code) => {
        if (code !== 0) resolve(null);
        else resolve(Buffer.concat(chunks).toString("utf8"));
      });
    } catch {
      resolve(null);
    }
  });
}

function pasteMethodFor(command: CopyCommand): PasteMethod {
  if (command.bin === "pbpaste") return "pbpaste";
  if (command.bin === "wl-paste") return "wl-paste";
  if (command.bin === "powershell") return "powershell";
  return "xclip";
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

  const commands = resolveCopyCommands(deps.platform, deps.env);
  for (const command of commands) {
    const copied = deps.spawn
      ? await spawnCopyWithFn(text, command, deps.spawn)
      : await spawnCopy(text, command);
    if (copied) {
      return { ok: true, method: copyMethodFor(command), lineCount };
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

export async function readFromClipboard(
  deps: Pick<ClipboardDeps, "platform" | "env" | "readText"> = {},
): Promise<ReadResult> {
  const command = resolvePasteCommand(deps.platform, deps.env);
  if (!command) {
    return { ok: false, error: "clipboard read unavailable on this platform" };
  }

  const text = deps.readText ? await deps.readText(command) : await spawnRead(command);
  if (text === null) {
    return { ok: false, error: "clipboard read failed" };
  }
  if (!text) {
    return { ok: false, error: "clipboard is empty" };
  }

  return { ok: true, text, method: pasteMethodFor(command) };
}

export function formatPasteStatus(result: ReadResult, pastedChars: number): string {
  if (result.ok) return `Pasted from clipboard (${pastedChars} chars)`;
  return result.error ?? "Clipboard unavailable in this terminal";
}
