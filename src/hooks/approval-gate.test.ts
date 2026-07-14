import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createHookRegistry } from "./registry.js";
import { installApprovalGate } from "./approval-gate.js";
import type { ApprovalMode } from "../approval/policy.js";
import type { Tool } from "../tools/types.js";
import { testAgentContext } from "../test-helpers.js";

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({
    approval: {
      mode: "normal",
      autoApprovedCommands: ["git status"],
    },
  }),
}));

describe("installApprovalGate", () => {
  const bashTool: Tool<{ command: string }> = {
    name: "bash",
    description: "run shell",
    schema: z.object({ command: z.string() }),
    needsApproval: () => true,
    async execute({ command }) {
      return { output: command };
    },
  };

  const ctx = testAgentContext("/tmp");

  it("blocks write tools in plan mode", async () => {
    const hooks = createHookRegistry();
    installApprovalGate(hooks, {
      mode: "plan",
      autoAcceptCli: false,
      tools: [bashTool],
    });

    const result = await hooks.fireHook(
      "before_tool",
      { id: "tc1", name: "bash", args: { command: "ls" } },
      ctx,
    );

    expect(result).toEqual({ block: true, reason: "Tool bash blocked in plan mode." });
  });

  it("blocks MCP tools in plan mode", async () => {
    const mcpTool: Tool<Record<string, unknown>> = {
      name: "fs__write_file",
      description: "write via MCP",
      schema: z.record(z.string(), z.unknown()),
      needsApproval: () => true,
      async execute() {
        return { output: "ok" };
      },
    };
    const hooks = createHookRegistry();
    installApprovalGate(hooks, {
      mode: "plan",
      autoAcceptCli: false,
      tools: [mcpTool],
    });

    const result = await hooks.fireHook(
      "before_tool",
      { id: "tc1", name: "fs__write_file", args: { path: "x" } },
      ctx,
    );

    expect(result).toEqual({
      block: true,
      reason: "Tool fs__write_file blocked in plan mode.",
    });
  });

  it("auto-approves configured bash commands without prompting", async () => {
    const hooks = createHookRegistry();
    const confirm = vi.fn();
    installApprovalGate(hooks, {
      mode: "normal",
      autoAcceptCli: false,
      tools: [bashTool],
      confirm,
    });

    const result = await hooks.fireHook(
      "before_tool",
      { id: "tc1", name: "bash", args: { command: "git status" } },
      ctx,
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("prompts for bash commands not in autoApprovedCommands", async () => {
    const hooks = createHookRegistry();
    const confirm = vi.fn().mockResolvedValue(true);
    installApprovalGate(hooks, {
      mode: "normal",
      autoAcceptCli: false,
      tools: [bashTool],
      confirm,
    });

    await hooks.fireHook(
      "before_tool",
      { id: "tc1", name: "bash", args: { command: "git diff" } },
      ctx,
    );

    expect(confirm).toHaveBeenCalledWith("bash", { command: "git diff" }, undefined);
  });

  it("skips approval for inner tools invoked via invoke_tool", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const hooks = createHookRegistry();
    installApprovalGate(hooks, {
      mode: "normal",
      autoAcceptCli: false,
      tools: [bashTool],
      confirm,
    });

    const ctx = { ...testAgentContext("/tmp"), invokeToolInner: "bash" };
    await hooks.fireHook(
      "before_tool",
      { id: "tc1", name: "bash", args: { command: "git diff" } },
      ctx,
    );

    expect(confirm).not.toHaveBeenCalled();
  });

  it("emits providerInputSchema for MCP tools awaiting approval", async () => {
    const inputSchema = {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    };
    const mcpTool: Tool<Record<string, unknown>> = {
      name: "fs__read_file",
      description: "read via MCP",
      schema: z.record(z.string(), z.unknown()),
      providerInputSchema: inputSchema,
      needsApproval: () => true,
      async execute() {
        return { output: "ok" };
      },
    };
    const hooks = createHookRegistry();
    const events: unknown[] = [];
    hooks.observe((event) => {
      events.push(event);
    });
    installApprovalGate(hooks, {
      mode: "normal",
      autoAcceptCli: false,
      tools: [mcpTool],
      confirm: vi.fn().mockResolvedValue(true),
    });

    await hooks.fireHook(
      "before_tool",
      { id: "tc1", name: "fs__read_file", args: { path: "a.txt" } },
      ctx,
    );

    expect(events).toEqual([
      {
        type: "approval_required",
        id: "tc1",
        name: "fs__read_file",
        args: { path: "a.txt" },
        providerInputSchema: inputSchema,
      },
    ]);
  });

  // Issue #142: switching approval mode mid-session must not crash the loop.
  // The TUI mutates the shared ref's `mode` between turns; the gate reads it
  // live on each before_tool, so every mode must resolve cleanly.
  it("honors mode flips on the shared ref across successive turns", async () => {
    const hooks = createHookRegistry();
    const confirm = vi.fn().mockResolvedValue(true);
    const ref = {
      mode: "normal" as const as ApprovalMode,
      autoAcceptCli: false,
      tools: [bashTool],
      confirm,
    };
    installApprovalGate(hooks, ref);

    const fire = () =>
      hooks.fireHook("before_tool", { id: "tc", name: "bash", args: { command: "git diff" } }, ctx);

    // normal → prompts
    expect(await fire()).toBeUndefined();
    expect(confirm).toHaveBeenCalledTimes(1);

    // switch to plan → blocks, no prompt
    ref.mode = "plan";
    expect(await fire()).toEqual({ block: true, reason: "Tool bash blocked in plan mode." });
    expect(confirm).toHaveBeenCalledTimes(1);

    // switch to auto-accept → runs without prompting
    ref.mode = "auto-accept";
    expect(await fire()).toBeUndefined();
    expect(confirm).toHaveBeenCalledTimes(1);

    // back to normal → prompts again
    ref.mode = "normal";
    expect(await fire()).toBeUndefined();
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
