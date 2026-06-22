import { access, lstat, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { resolvePathWithinRoot } from "../util/paths.js";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

const schema = z
  .object({
    operation: z.enum(["delete", "move"]).describe("File operation to perform"),
    source: z.string().describe("Source file path relative to workspace root"),
    destination: z
      .string()
      .optional()
      .describe("Destination path for move (required when operation is move)"),
  })
  .superRefine((data, ctx) => {
    if (data.operation === "move" && !data.destination) {
      ctx.addIssue({
        code: "custom",
        message: "destination is required when operation is move",
        path: ["destination"],
      });
    }
  });

export type FileOpArgs = z.infer<typeof schema>;

async function assertSourceFile(
  sourcePath: string,
  operation: FileOpArgs["operation"],
): Promise<{ ok: true } | { ok: false; output: string }> {
  let stat;
  try {
    stat = await lstat(sourcePath);
  } catch {
    return { ok: false, output: `Source file does not exist: ${sourcePath}` };
  }

  if (stat.isDirectory()) {
    if (operation === "delete") {
      return {
        ok: false,
        output: "file_op delete is files-only; use bash rm -r for directories",
      };
    }
    return { ok: false, output: `Source is not a file: ${sourcePath}` };
  }

  if (!stat.isFile()) {
    return { ok: false, output: `Source is not a file: ${sourcePath}` };
  }

  return { ok: true };
}

export const fileOpTool: Tool<FileOpArgs> = {
  name: "file_op",
  description: loadToolDescription("file-op"),
  schema,
  needsApproval: () => true,
  async execute({ operation, source, destination }, ctx) {
    let sourcePath: string;
    let destinationPath: string | undefined;

    try {
      sourcePath = resolvePathWithinRoot(ctx.cwd, source);
      if (destination) {
        destinationPath = resolvePathWithinRoot(ctx.cwd, destination);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: message, isError: true };
    }

    const sourceCheck = await assertSourceFile(sourcePath, operation);
    if (!sourceCheck.ok) {
      return { output: sourceCheck.output, isError: true };
    }

    if (operation === "delete") {
      await unlink(sourcePath);
      return { output: `Deleted ${source}` };
    }

    const destParent = dirname(destinationPath!);
    try {
      await access(destParent);
    } catch {
      return {
        output: `Destination parent directory does not exist: ${destParent}`,
        isError: true,
      };
    }

    await rename(sourcePath, destinationPath!);
    return { output: `Moved ${source} → ${destination}` };
  },
};
