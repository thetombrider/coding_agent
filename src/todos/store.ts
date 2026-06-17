import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "../types.js";
import { todowriteSchema } from "../tools/todowrite.js";
import type { TodoItem, TodoStatus } from "./types.js";

const STATUS_GLYPH: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[→]",
  completed: "[✓]",
  cancelled: "[–]",
};

export function countCompletedTodos(todos: TodoItem[]): number {
  return todos.filter((t) => t.status === "completed" || t.status === "cancelled").length;
}

export function hasActiveTodos(todos: TodoItem[]): boolean {
  return todos.some((t) => t.status === "pending" || t.status === "in_progress");
}

/** Format the current list as a REMINDERS block for per-turn re-injection. */
export function formatRemindersBlock(todos: TodoItem[]): string {
  if (!todos.length) return "";

  const completed = countCompletedTodos(todos);
  const lines = todos.map(
    (t) => `${STATUS_GLYPH[t.status]} ${t.content} (${t.status})`,
  );

  return [
    "REMINDERS",
    `Task progress: ${completed}/${todos.length}`,
    ...lines,
  ].join("\n");
}

/** Rebuild session todos from the last todowrite tool call in message history. */
export function rebuildTodosFromMessages(messages: Message[]): TodoItem[] {
  let latest: TodoItem[] = [];

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall" || block.name !== "todowrite") continue;
      const parsed = todowriteSchema.safeParse(block.arguments);
      if (parsed.success) latest = parsed.data.todos;
    }
  }

  return latest;
}

/** Optional export to `.orin/todo.md` when enabled in config. */
export function writeTodoExport(cwd: string, todos: TodoItem[]): void {
  const dir = join(cwd, ".orin");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const completed = countCompletedTodos(todos);
  const lines = todos.map((t) => `- ${STATUS_GLYPH[t.status]} ${t.content}`);

  const body = [
    "# Session tasks",
    "",
    `Progress: ${completed}/${todos.length}`,
    "",
    ...lines,
    "",
  ].join("\n");

  writeFileSync(join(dir, "todo.md"), body, "utf8");
}
