import { z } from "zod";
import { resolvePath } from "../util/paths.js";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

const schema = z.object({
  path: z.string().describe("File path relative to workspace root or absolute"),
  content: z.string().describe("Full file content to write"),
});

export type WriteArgs = z.infer<typeof schema>;

export const writeTool: Tool<WriteArgs> = {
  name: "write",
  description: loadToolDescription("write"),
  schema,
  needsApproval: () => true,
  async execute({ path, content }, ctx) {
    const fullPath = resolvePath(ctx.cwd, path);
    await ctx.workspace.writeFile(fullPath, content);
    return { output: `Wrote ${path} (${content.length} bytes)` };
  },
};
