import { describe, expect, it } from "vitest";
import { testAgentContext } from "../test-helpers.js";
import type { TodoItem } from "../todos/types.js";
import { todowriteTool } from "./todowrite.js";

const sampleTodos: TodoItem[] = [
  { id: "1", content: "Read codebase", status: "completed" },
  { id: "2", content: "Implement feature", status: "in_progress" },
  { id: "3", content: "Add tests", status: "pending" },
];

describe("todowriteTool", () => {
  it("replaces the session task list", async () => {
    const ctx = testAgentContext("/tmp");
    const result = await todowriteTool.execute({ todos: sampleTodos }, ctx, new AbortController().signal);

    expect(result.isError).toBeFalsy();
    expect(ctx.todos).toEqual(sampleTodos);
    expect(result.output).toContain("3 todos");
    expect(result.output).toContain("1/3 completed");
  });

  it("rejects more than one in_progress item", async () => {
    const ctx = testAgentContext("/tmp");
    const result = await todowriteTool.execute(
      {
        todos: [
          { id: "1", content: "A", status: "in_progress" },
          { id: "2", content: "B", status: "in_progress" },
        ],
      },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("at most one todo");
    expect(ctx.todos).toBeUndefined();
  });
});
