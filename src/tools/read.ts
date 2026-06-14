import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

const schema = z.object({
  path: z.string().describe("File path relative to workspace root or absolute"),
});

export type ReadArgs = z.infer<typeof schema>;

function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export const readTool: Tool<ReadArgs> = {
  name: "read",
  description: loadToolDescription("read"),
  schema,
  async execute({ path }, ctx) {
    const fullPath = resolvePath(ctx.cwd, path);
    const content = await readFile(fullPath, "utf8");
    return { output: content };
  },
};
