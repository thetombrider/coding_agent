import { z } from "zod";
import { resolvePath } from "../util/paths.js";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

/** Default cap on lines returned in one read — keeps a single file from flooding context. */
export const DEFAULT_READ_LINE_LIMIT = 2000;
/** Hard cap on bytes returned regardless of line count (e.g. minified/one-line files). */
export const MAX_READ_BYTES = 256 * 1024;

const schema = z.object({
  path: z.string().describe("File path relative to workspace root or absolute"),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based line number to start reading from (default: 1)"),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`Maximum lines to return (default ${DEFAULT_READ_LINE_LIMIT})`),
});

export type ReadArgs = z.infer<typeof schema>;

export const readTool: Tool<ReadArgs> = {
  name: "read",
  description: loadToolDescription("read"),
  schema,
  async execute({ path, offset, limit }, ctx) {
    const fullPath = resolvePath(ctx.cwd, path);
    const content = await ctx.workspace.readFile(fullPath);

    // `split("\n")` yields a trailing "" for the common trailing-newline case;
    // drop it so line numbers read naturally (a final newline terminates the
    // last line rather than starting an empty one).
    const lines = content.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const totalLines = lines.length;

    const start = (offset ?? 1) - 1;
    const max = limit ?? DEFAULT_READ_LINE_LIMIT;
    const overLineLimit = start + max < totalLines || start > 0;
    const overByteLimit = content.length > MAX_READ_BYTES;

    // Unbounded read of a file that fits both caps → return it verbatim, so a
    // normal read stays byte-for-byte identical to a plain file read.
    if (offset === undefined && limit === undefined && !overLineLimit && !overByteLimit) {
      return { output: content };
    }

    let slice = lines.slice(start, start + max).join("\n");
    const notes: string[] = [];
    if (slice.length > MAX_READ_BYTES) {
      slice = slice.slice(0, MAX_READ_BYTES);
      notes.push(`output truncated to ${MAX_READ_BYTES} bytes`);
    }

    const shownEnd = Math.min(start + max, totalLines);
    const remaining = totalLines - shownEnd;
    if (remaining > 0) {
      notes.push(
        `${remaining} more line${remaining === 1 ? "" : "s"} not shown — `
          + `re-read with offset ${shownEnd + 1} to continue`,
      );
    }

    if (notes.length === 0) return { output: slice };
    return {
      output: `${slice}\n\n[read: lines ${start + 1}-${shownEnd} of ${totalLines}; ${notes.join("; ")}]`,
    };
  },
};
