import { z } from "zod";
import { loadToolDescription } from "../util/load-txt.js";
import { MAX_COMMAND_OUTPUT_BYTES, truncationNote } from "./output-limits.js";
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
    const { exitCode, truncated } = await ctx.workspace.exec(command, ctx.cwd, {
      onData: (chunk) => {
        output += chunk.toString();
      },
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      signal,
    });

    // The byte cap kills the child, so the exit code is a kill signal, not a
    // genuine command failure — surface the capped output as a normal result.
    if (truncated) {
      return { output: output + truncationNote(MAX_COMMAND_OUTPUT_BYTES) };
    }

    const suffix = exitCode === 0 ? "" : `\n[exit ${exitCode ?? "signal"}]`;
    return {
      output: output + suffix,
      isError: exitCode !== 0,
    };
  },
};
