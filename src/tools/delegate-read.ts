import { z } from "zod";
import { runDelegateRead } from "../delegate/delegate-read.js";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

const schema = z.object({
  task: z.string().describe("What to find out, in one sentence."),
  paths: z
    .array(z.string())
    .optional()
    .describe(
      "Files or globs to read into the cheap model. Prefer this tool over task when "
      + "paths are known and you only need a one-shot summary.",
    ),
});

export type DelegateReadArgs = z.infer<typeof schema>;

export const delegateReadTool: Tool<DelegateReadArgs> = {
  name: "delegate_read",
  description: loadToolDescription("delegate-read"),
  schema,
  async execute({ task, paths }, ctx, signal) {
    const { answer, warnings } = await runDelegateRead({
      task,
      paths,
      cwd: ctx.cwd,
      workspace: ctx.workspace,
      signal,
      record: ctx.loopHost?.recordLlmCall,
    });

    const prefix = warnings.length ? `${warnings.join("\n")}\n\n` : "";
    return { output: prefix + (answer || "(no summary returned)") };
  },
};
