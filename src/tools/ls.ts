import { z } from "zod";
import { resolvePath } from "../util/paths.js";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

const schema = z.object({
  path: z.string().optional().describe("Directory to list (default: workspace root)"),
});

export type LsArgs = z.infer<typeof schema>;

export const lsTool: Tool<LsArgs> = {
  name: "ls",
  description: loadToolDescription("ls"),
  schema,
  async execute({ path }, ctx) {
    const dir = resolvePath(ctx.cwd, path ?? ".");
    let raw = "";
    const { exitCode } = await ctx.workspace.exec("ls -1p", dir, {
      onData: (chunk) => {
        raw += chunk.toString();
      },
    });
    if (exitCode !== 0) {
      throw new Error(raw.trim() || `ls failed with exit ${exitCode}`);
    }

    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((name) => {
        const isDir = name.endsWith("/");
        const label = isDir ? name.slice(0, -1) : name;
        return `${isDir ? "d" : "f"} ${label}`;
      })
      .sort();

    return { output: lines.join("\n") || "(empty)" };
  },
};
