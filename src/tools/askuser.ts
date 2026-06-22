import { z } from "zod";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

const schema = z.object({
  question: z.string().describe("The question to ask the user."),
  options: z
    .array(z.string())
    .min(2, { message: "Provide at least 2 options." })
    .max(4, {
      message:
        "Provide at most 4 options. If more than four possibilities exist, keep only the "
        + "4 most important (or combine some) — the user can also reply with free-text.",
    })
    .describe(
      "Between 2 and 4 distinct, mutually exclusive options (never more than 4). "
      + "If more possibilities exist, present only the 4 most likely.",
    ),
});

export type AskUserArgs = z.infer<typeof schema>;

export const askUserTool: Tool<AskUserArgs> = {
  name: "askuser",
  description: loadToolDescription("askuser"),
  schema,
  async execute({ question, options }, ctx) {
    // No interactive prompt available (headless run, or a subagent context that
    // doesn't wire one). Tell the model to decide for itself instead of hanging.
    if (!ctx.askUser) {
      return {
        output:
          "No interactive user is available to answer (non-interactive session). "
          + "Pick the most reasonable option yourself, state the assumption, and continue.",
        isError: true,
      };
    }

    const answer = await ctx.askUser(question, options);
    if (answer === null || answer.trim() === "") {
      return {
        output: "The user dismissed the question without answering. Proceed with your best judgment.",
        isError: true,
      };
    }

    return { output: `The user answered: ${answer}` };
  },
};
