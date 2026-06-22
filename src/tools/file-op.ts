import { dirname, isAbsolute, relative } from "node:path";
import { z } from "zod";
import { resolvePath } from "../util/paths.js";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

const schema = z.object({
  operation: z.enum(["delete", "move"]).describe('"delete" removes a file; "move" renames/relocates it'),
  source: z.string().describe("File to delete or move (relative to workspace root or absolute)"),
  destination: z
    .string()
    .optional()
    .describe('Target path — required when operation is "move"'),
});

export type FileOpArgs = z.infer<typeof schema>;

/** Resolve `p` against `cwd` and reject anything that escapes the workspace root. */
function resolveWithin(cwd: string, p: string): string | null {
  const full = resolvePath(cwd, p);
  const rel = relative(cwd, full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return full;
}

export const fileOpTool: Tool<FileOpArgs> = {
  name: "file_op",
  description: loadToolDescription("file-op"),
  schema,
  needsApproval: () => true,
  async execute({ operation, source, destination }, ctx) {
    const src = resolveWithin(ctx.cwd, source);
    if (!src) {
      return { output: `Refusing to operate on a path outside the workspace: ${source}`, isError: true };
    }

    const srcStat = await ctx.workspace.stat(src);
    if (!srcStat) {
      return { output: `Source not found: ${source}`, isError: true };
    }
    if (!srcStat.isFile) {
      const hint = operation === "delete" ? "rm -r" : "mv";
      return {
        output: `file_op ${operation} is files-only; use bash ${hint} for directories`,
        isError: true,
      };
    }

    if (operation === "delete") {
      await ctx.workspace.deleteFile(src);
      return { output: `Deleted ${source}` };
    }

    // move
    if (!destination) {
      return { output: 'destination is required when operation is "move"', isError: true };
    }
    const dest = resolveWithin(ctx.cwd, destination);
    if (!dest) {
      return { output: `Refusing to move to a path outside the workspace: ${destination}`, isError: true };
    }
    const parentStat = await ctx.workspace.stat(dirname(dest));
    if (!parentStat || !parentStat.isDirectory) {
      return { output: `Destination directory does not exist: ${dirname(destination)}`, isError: true };
    }
    await ctx.workspace.move(src, dest);
    return { output: `Moved ${source} -> ${destination}` };
  },
};
