import { rgPath } from "@vscode/ripgrep";
import { z } from "zod";
import { resolvePath } from "../util/paths.js";
import { shellQuote } from "../util/shell.js";
import { loadToolDescription } from "../util/load-txt.js";
import { MAX_COMMAND_OUTPUT_BYTES, truncationNote } from "./output-limits.js";
import type { Tool } from "./types.js";

const schema = z.object({
  pattern: z.string().describe("Regex or literal pattern to search for"),
  path: z.string().optional().describe("File or directory to search (default: workspace root)"),
  glob: z.string().optional().describe("Glob filter, e.g. *.ts (ripgrep -g)"),
  context: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe("Lines of context before and after each match (ripgrep -C); use instead of reading the whole file"),
});

export type GrepArgs = z.infer<typeof schema>;

async function runRipgrep(
  ctx: { cwd: string; workspace: import("../workspace/types.js").Workspace },
  command: string,
  signal: AbortSignal,
): Promise<string> {
  let output = "";
  const { exitCode, truncated } = await ctx.workspace.exec(command, ctx.cwd, {
    onData: (chunk) => {
      output += chunk.toString();
    },
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    signal,
  });
  // Truncation is checked before exitCode: capping kills the child (non-zero/null
  // exit), but the partial matches are still useful — return them, don't throw.
  if (truncated) return (output || "(no matches)") + truncationNote(MAX_COMMAND_OUTPUT_BYTES);
  if (exitCode === 0 || exitCode === 1) return output || "(no matches)";
  throw new Error(output || `command failed with exit ${exitCode}`);
}

export const grepTool: Tool<GrepArgs> = {
  name: "grep",
  description: loadToolDescription("grep"),
  schema,
  async execute({ pattern, path, glob, context }, ctx, signal) {
    const target = shellQuote(resolvePath(ctx.cwd, path ?? "."));
    const pat = shellQuote(pattern);
    const ctxFlag = context !== undefined ? ` -C ${context}` : "";
    const globFlag = glob ? ` -g ${shellQuote(glob)}` : "";
    const rg = shellQuote(rgPath);
    const command = `${rg} --line-number --color=never${ctxFlag}${globFlag} -- ${pat} ${target}`;
    return { output: await runRipgrep(ctx, command, signal) };
  },
};
