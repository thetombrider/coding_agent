import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
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
    const entries = await readdir(dir);
    const lines: string[] = [];
    for (const name of entries.sort()) {
      const info = await stat(join(dir, name));
      lines.push(`${info.isDirectory() ? "d" : "f"} ${name}`);
    }
    return { output: lines.join("\n") || "(empty)" };
  },
};
