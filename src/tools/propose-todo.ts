import { z } from "zod";
import type { TodoItem } from "../todos/types.js";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

const todoItemSchema = z.object({
  id: z.string().describe("Unique identifier for this task"),
  content: z.string().describe("Task description"),
  status: z
    .enum(["pending", "in_progress", "completed", "cancelled"])
    .describe("Task status"),
});

export const proposeTodoSchema = z.object({
  todos: z
    .array(todoItemSchema)
    .describe(
      "Full replacement task list for the parent loop. Subagents do not own the "
      + "session plan; the parent applies this proposal to its own list.",
    ),
});

export type ProposeTodoArgs = z.infer<typeof proposeTodoSchema>;

function countInProgress(todos: TodoItem[]): number {
  return todos.filter((t) => t.status === "in_progress").length;
}

/**
 * Subagent-only `todowrite` variant (issue #149). The child has no plan ownership,
 * so it never mutates its own `ctx.todos` — instead the `installProposeTodo` hook
 * reads the validated args from the `after_tool` event and emits a `todo_proposal`
 * on the *child's* hook registry. The child → parent forwarder in `task.ts` then
 * re-emits on the host's hooks with `subagentId` so the parent session can apply
 * the proposal to its own plan.
 */
export const proposeTodoTool: Tool<ProposeTodoArgs> = {
  name: "propose_todo",
  description: loadToolDescription("propose-todo"),
  schema: proposeTodoSchema,
  async execute({ todos }, ctx) {
    if (countInProgress(todos) > 1) {
      return {
        output: "Error: at most one todo may have status in_progress",
        isError: true,
      };
    }

    // The child has no `loopHost` only when this tool is invoked outside a subagent
    // (e.g. a unit test or a misuse from the parent loop, which is forbidden by the
    // registry). Without a host there is no parent to receive the proposal — fail
    // loudly rather than silently dropping the update.
    if (!ctx.loopHost) {
      return {
        output:
          "Error: propose_todo is only available to subagents. The parent loop owns the session task list and should use todowrite directly.",
        isError: true,
      };
    }

    const completed = todos.filter((t) => t.status === "completed").length;
    return {
      output: `Proposed ${todos.length} todos to the parent (${completed}/${todos.length} completed). The parent will apply or reject the proposal on its next turn.`,
    };
  },
};

