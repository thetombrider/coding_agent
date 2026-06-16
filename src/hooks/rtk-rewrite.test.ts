import { describe, expect, it } from "vitest";
import { createHookRegistry } from "./registry.js";
import { installRtkRewrite } from "./rtk-rewrite.js";
import { testAgentContext } from "../test-helpers.js";

describe("installRtkRewrite", () => {
  it("does nothing when rtk is not installed", async () => {
    const hooks = createHookRegistry();
    installRtkRewrite(hooks, () => false);

    const result = await hooks.fireHook(
      "before_tool",
      { id: "tc1", name: "bash", args: { command: "git log" } },
      testAgentContext("/tmp"),
    );

    expect(result).toBeUndefined();
  });

  it("rewrites supported bash commands when rtk is installed", async () => {
    const hooks = createHookRegistry();
    installRtkRewrite(hooks, () => true);

    const result = await hooks.fireHook(
      "before_tool",
      { id: "tc1", name: "bash", args: { command: "git log --oneline" } },
      testAgentContext("/tmp"),
    );

    expect(result).toEqual({ args: { command: "rtk git log --oneline" } });
  });

  it("skips commands already prefixed with rtk", async () => {
    const hooks = createHookRegistry();
    installRtkRewrite(hooks, () => true);

    const result = await hooks.fireHook(
      "before_tool",
      { id: "tc1", name: "bash", args: { command: "rtk git log" } },
      testAgentContext("/tmp"),
    );

    expect(result).toBeUndefined();
  });

  it("rewrites supported bash commands in e2b workspace even when local rtk lookup fails", async () => {
    const hooks = createHookRegistry();
    installRtkRewrite(hooks, () => false);

    const baseCtx = testAgentContext("/tmp");
    const e2bCtx = {
      ...baseCtx,
      workspace: { ...baseCtx.workspace, kind: "e2b" as const },
    };

    const result = await hooks.fireHook(
      "before_tool",
      { id: "tc1", name: "bash", args: { command: "git log --oneline" } },
      e2bCtx,
    );

    expect(result).toEqual({ args: { command: "rtk git log --oneline" } });
  });
});
