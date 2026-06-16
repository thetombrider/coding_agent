import { z } from "zod";
import { resolvePath } from "../util/paths.js";
import { shellQuote } from "../util/shell.js";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

const schema = z.object({
  pattern: z.string().describe("Regex or literal pattern to search for"),
  path: z.string().optional().describe("File or directory to search (default: workspace root)"),
  glob: z.string().optional().describe("Glob filter, e.g. *.ts (ripgrep -g)"),
});

export type GrepArgs = z.infer<typeof schema>;

async function runGrep(
  ctx: { cwd: string; workspace: import("../workspace/types.js").Workspace },
  command: string,
  signal: AbortSignal,
): Promise<string> {
  let output = "";
  const { exitCode } = await ctx.workspace.exec(command, ctx.cwd, {
    onData: (chunk) => {
      output += chunk.toString();
    },
    signal,
  });
  if (exitCode === 0 || exitCode === 1) return output || "(no matches)";
  throw new Error(output || `command failed with exit ${exitCode}`);
}

export const grepTool: Tool<GrepArgs> = {
  name: "grep",
  description: loadToolDescription("grep"),
  schema,
  async execute({ pattern, path, glob }, ctx, signal) {
    const target = shellQuote(resolvePath(ctx.cwd, path ?? "."));
    const pat = shellQuote(pattern);
    const rgArgs = glob
      ? `rg --line-number --color=never -g ${shellQuote(glob)} -- ${pat} ${target}`
      : `rg --line-number --color=never -- ${pat} ${target}`;
    try {
      return { output: await runGrep(ctx, rgArgs, signal) };
    } catch {
      const grepArgs = `grep -rn -- ${pat} ${target}`;
      return { output: await runGrep(ctx, grepArgs, signal) };
    }
  },
};
