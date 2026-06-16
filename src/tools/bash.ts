import { z } from "zod";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

const schema = z.object({
  command: z.string().describe("Shell command to run"),
});

export type BashArgs = z.infer<typeof schema>;

export const bashTool: Tool<BashArgs> = {
  name: "bash",
  description: loadToolDescription("bash"),
  schema,
  needsApproval: () => true,
  async execute({ command }, ctx, signal) {
    let output = "";
    const { exitCode } = await ctx.workspace.exec(command, ctx.cwd, {
      onData: (chunk) => {
        output += chunk.toString();
      },
      signal,
    });

    const suffix = exitCode === 0 ? "" : `\n[exit ${exitCode}]`;
    return {
      output: output + suffix,
      isError: exitCode !== 0 && exitCode !== null,
    };
  },
};
