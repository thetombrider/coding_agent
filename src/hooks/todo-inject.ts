import { injectLeadingContext } from "../prompt/inject.js";
import { formatRemindersBlock } from "../todos/store.js";
import type { HookRegistryImpl } from "./registry.js";

export function installTodoInject(hooks: HookRegistryImpl): void {
  hooks.on("before_prompt", ({ messages }, ctx) => {
    const todos = ctx.todos ?? [];
    if (!todos.length) return;
    const block = formatRemindersBlock(todos);
    return { messages: injectLeadingContext(messages, block) };
  });

  hooks.on("after_tool", ({ name, output }, ctx) => {
    if (name !== "todowrite" || output.startsWith("Error")) return;
    hooks.emit({ type: "todo_update", todos: ctx.todos ?? [] });
  });
}
