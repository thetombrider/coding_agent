import { spawn } from "node:child_process";
import { z } from "zod";
import { resolvePath } from "../util/paths.js";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

const schema = z.object({
  pattern: z.string().describe("Regex or literal pattern to search for"),
  path: z.string().optional().describe("File or directory to search (default: workspace root)"),
  glob: z.string().optional().describe("Glob filter, e.g. *.ts (ripgrep -g)"),
});

export type GrepArgs = z.infer<typeof schema>;

function runCommand(command: string, args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || code === 1) resolvePromise(stdout || stderr || "(no matches)");
      else reject(new Error(stderr || `${command} exited ${code}`));
    });
  });
}

export const grepTool: Tool<GrepArgs> = {
  name: "grep",
  description: loadToolDescription("grep"),
  schema,
  async execute({ pattern, path, glob }, ctx, signal) {
    const target = resolvePath(ctx.cwd, path ?? ".");
    try {
      const args = ["--line-number", "--color=never", pattern, target];
      if (glob) args.splice(1, 0, "-g", glob);
      return { output: await runCommand("rg", args, ctx.cwd, signal) };
    } catch {
      const args = ["-rn", pattern, target];
      return { output: await runCommand("grep", args, ctx.cwd, signal) };
    }
  },
};
