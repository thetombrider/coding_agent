import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createHookRegistry } from "./registry.js";
import { installApprovalGate } from "./approval-gate.js";
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

    expect(confirm).toHaveBeenCalledWith("bash", { command: "git diff" });
  });
});
