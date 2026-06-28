import type { ReadArgs } from "../tools/read.js";
import { resolvePath } from "../util/paths.js";
import type { HookRegistry } from "./types.js";

/** Files above this line count require delegate_read for broad reads on the main agent. */
export const DELEGATE_READ_LINE_THRESHOLD = 500;
/** Same for byte-heavy files (e.g. minified bundles). */
export const DELEGATE_READ_BYTE_THRESHOLD = 64 * 1024;
/** Small limit-only reads from the start of a file stay allowed on large files. */
export const MAX_TARGETED_READ_LINES = 200;

function countLines(content: string): number {
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/** True when the read would pull a large unbounded slice into the main context. */
export function isBroadRead(args: ReadArgs): boolean {
  if (args.offset !== undefined) return false;
  if (args.limit !== undefined && args.limit <= MAX_TARGETED_READ_LINES) return false;
  return true;
}

function blockReason(path: string, lines: number, bytes: number): string {
  const sizeKb = Math.ceil(bytes / 1024);
  return (
    `File "${path}" is too large for a direct read (${lines} lines, ${sizeKb} KB). `
    + `Use delegate_read with paths: ["${path}"] and a focused task for summaries — `
    + `raw file contents stay out of your context. `
    + `To inspect a specific symbol, use search_symbols (mode=definitions) to get the `
    + `start line, then read with offset and limit (≤${MAX_TARGETED_READ_LINES} lines). `
    + `For string/regex patterns, grep first, then read the matching section the same way.`
  );
}

export function installDelegateReadGate(hooks: HookRegistry): void {
  hooks.on("before_tool", async ({ name, args }, ctx) => {
    if (name !== "read") return;
    if ((ctx.depth ?? 0) > 0) return;

    const readArgs = args as ReadArgs;
    if (!isBroadRead(readArgs)) return;

    const fullPath = resolvePath(ctx.cwd, readArgs.path);
    const stat = await ctx.workspace.stat(fullPath);
    if (!stat?.isFile) return;

    let content: string;
    try {
      content = await ctx.workspace.readFile(fullPath);
    } catch {
      return;
    }

    const lines = countLines(content);
    const bytes = content.length;
    if (lines <= DELEGATE_READ_LINE_THRESHOLD && bytes <= DELEGATE_READ_BYTE_THRESHOLD) {
      return;
    }

    return {
      block: true,
      reason: blockReason(readArgs.path, lines, bytes),
    };
  });
}
