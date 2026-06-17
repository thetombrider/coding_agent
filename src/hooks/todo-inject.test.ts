import { describe, expect, it } from "vitest";
import { createHookRegistry } from "./registry.js";
import { installTodoInject } from "./todo-inject.js";
import { testAgentContext } from "../test-helpers.js";
import type { TodoItem } from "../todos/types.js";

const todos: TodoItem[] = [
  { id: "1", content: "Implement todowrite", status: "in_progress" },
  { id: "2", content: "Add tests", status: "pending" },
];

describe("installTodoInject", () => {
  it("injects REMINDERS into before_prompt messages", async () => {
    const hooks = createHookRegistry();
    installTodoInject(hooks);
    const ctx = testAgentContext("/tmp", [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    ctx.todos = todos;

    const result = await hooks.fireHook(
      "before_prompt",
      { messages: ctx.messages, model: "faux:test" },
      ctx,
    );

    const injected = result && "messages" in result ? result.messages[0] : undefined;
    const text = injected?.content[0].type === "text" ? injected.content[0].text : "";
    expect(text).toContain("REMINDERS");
    expect(text).toContain("Implement todowrite");
    expect(text).toContain("Task progress: 0/2");
  });

  it("skips injection when the list is empty", async () => {
    const hooks = createHookRegistry();
    installTodoInject(hooks);
    const ctx = testAgentContext("/tmp", [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);

    const result = await hooks.fireHook(
      "before_prompt",
      { messages: ctx.messages, model: "faux:test" },
      ctx,
    );

    expect(result).toBeUndefined();
  });

  it("re-injects todos after message history is compacted to a summary", async () => {
    const hooks = createHookRegistry();
    installTodoInject(hooks);
    const ctx = testAgentContext("/tmp", [
      { role: "user", content: [{ type: "text", text: "[Session summary — turns 1–5]" }] },
    ]);
    ctx.todos = [{ id: "1", content: "Survive compaction", status: "in_progress" }];

    const result = await hooks.fireHook(
      "before_prompt",
      { messages: ctx.messages, model: "faux:test" },
      ctx,
    );

    const text =
      result && "messages" in result
        ? result.messages[0]?.content[0]?.type === "text"
          ? result.messages[0].content[0].text
          : ""
        : "";
    expect(text).toContain("Survive compaction");
  });
});
