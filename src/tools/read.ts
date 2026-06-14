import { readFile } from "node:fs/promises";
import { z } from "zod";
import { resolvePath } from "../util/paths.js";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

const schema = z.object({
  path: z.string().describe("File path relative to workspace root or absolute"),
});

export type ReadArgs = z.infer<typeof schema>;

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
