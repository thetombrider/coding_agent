import { describe, expect, it } from "vitest";
import { testAgentContext } from "../test-helpers.js";
import { createHookRegistry } from "../hooks/registry.js";
import { installCoreHooks } from "../hooks/install.js";
import type { ApprovalGateRef } from "../hooks/approval-gate.js";
import type { TodoItem } from "../todos/types.js";
import { proposeTodoTool } from "./propose-todo.js";
import type { AgentContext } from "../types.js";

const sampleTodos: TodoItem[] = [
  { id: "1", content: "Read codebase", status: "completed" },
  { id: "2", content: "Implement feature", status: "in_progress" },
  { id: "3", content: "Add tests", status: "pending" },
];

function ctxWithHost(hooks = createHookRegistry()): AgentContext {
  const ctx = testAgentContext("/tmp");
  ctx.loopHost = {
    provider: async () => ({ role: "assistant", content: [], model: "faux:test" }),
    model: "faux:test",
    hooks,
    approval: { mode: "auto-accept", autoAcceptCli: true, tools: [] },
  };
  return ctx;
}

function coreHooksWithApproval(): {
  hooks: ReturnType<typeof createHookRegistry>;
  approval: ApprovalGateRef;
} {
  const hooks = createHookRegistry();
  const approval: ApprovalGateRef = { mode: "auto-accept", autoAcceptCli: true, tools: [] };
  installCoreHooks(hooks, approval);
  return { hooks, approval };
}

describe("proposeTodoTool", () => {
  it("returns success without mutating the child context", async () => {
    const ctx = ctxWithHost();
    const result = await proposeTodoTool.execute(
      { todos: sampleTodos },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBeFalsy();
    // The child has no plan ownership — its own todos must not be mutated. The
    // proposal event is fired by the propose_todo hook, not the tool itself.
    expect(ctx.todos).toBeUndefined();
  });

  it("rejects more than one in_progress item", async () => {
    const ctx = ctxWithHost();
    const result = await proposeTodoTool.execute(
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
  });

  it("refuses to run when no parent host is reachable (forbidden on the parent loop)", async () => {
    const ctx = testAgentContext("/tmp"); // no loopHost
    const result = await proposeTodoTool.execute(
      { todos: sampleTodos },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("only available to subagents");
  });
});

describe("propose_todo hook wiring", () => {
  it("fires a todo_proposal on the child's hooks when core hooks are installed", async () => {
    // Simulate what `runLoop` does: it builds a hook registry, installs core
    // hooks, and on each tool completion fires `after_tool` for handlers.
    const { hooks } = coreHooksWithApproval();
    const ctx = ctxWithHost(hooks);
    const proposals: TodoItem[][] = [];
    hooks.observe((event) => {
      if (event.type === "todo_proposal") proposals.push(event.todos);
    });

    const result = await proposeTodoTool.execute(
      { todos: sampleTodos },
      ctx,
      new AbortController().signal,
    );
    expect(result.isError).toBeFalsy();

    // The tool itself does not emit on the host hooks — the `installProposeTodo`
    // hook does, fired off the `after_tool` event the loop would emit. Drive
    // that path manually here.
    await hooks.fireHook(
      "after_tool",
      { name: "propose_todo", args: { todos: sampleTodos }, output: result.output },
      ctx,
    );

    expect(proposals).toEqual([sampleTodos]);
  });

  it("does not fire a proposal when the tool returned an error", async () => {
    const { hooks } = coreHooksWithApproval();
    const ctx = ctxWithHost(hooks);
    const proposals: TodoItem[][] = [];
    hooks.observe((event) => {
      if (event.type === "todo_proposal") proposals.push(event.todos);
    });

    await hooks.fireHook(
      "after_tool",
      {
        name: "propose_todo",
        args: {
          todos: [
            { id: "1", content: "A", status: "in_progress" },
            { id: "2", content: "B", status: "in_progress" },
          ],
        },
        output: "Error: at most one todo may have status in_progress",
      },
      ctx,
    );

    expect(proposals).toEqual([]);
  });

  it("ignores after_tool for unrelated tools", async () => {
    const { hooks } = coreHooksWithApproval();
    const ctx = ctxWithHost(hooks);
    const proposals: TodoItem[][] = [];
    hooks.observe((event) => {
      if (event.type === "todo_proposal") proposals.push(event.todos);
    });

    await hooks.fireHook(
      "after_tool",
      { name: "read", args: { path: "x" }, output: "ok" },
      ctx,
    );

    expect(proposals).toEqual([]);
  });
});
