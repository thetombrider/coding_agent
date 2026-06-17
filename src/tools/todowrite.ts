import { z } from "zod";
import { loadConfig } from "../config/config.js";
import { writeTodoExport } from "../todos/store.js";
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

export const todowriteSchema = z.object({
  todos: z.array(todoItemSchema).describe("Full task list replacing the current session list"),
});

export type TodowriteArgs = z.infer<typeof todowriteSchema>;

function countInProgress(todos: TodoItem[]): number {
  return todos.filter((t) => t.status === "in_progress").length;
}

export const todowriteTool: Tool<TodowriteArgs> = {
  name: "todowrite",
  description: loadToolDescription("todowrite"),
  schema: todowriteSchema,
  async execute({ todos }, ctx) {
    if (countInProgress(todos) > 1) {
      return {
        output: "Error: at most one todo may have status in_progress",
        isError: true,
      };
    }

    ctx.todos = todos;

    if (loadConfig().todo?.export) {
      writeTodoExport(ctx.cwd, todos);
    }

    const completed = todos.filter((t) => t.status === "completed").length;
    return {
      output: `Updated ${todos.length} todos (${completed}/${todos.length} completed)`,
    };
  },
};
