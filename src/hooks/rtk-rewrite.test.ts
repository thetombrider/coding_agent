import { describe, expect, it } from "vitest";
import { createHookRegistry } from "./registry.js";
import { installRtkRewrite } from "./rtk-rewrite.js";

describe("installRtkRewrite", () => {
  it("does nothing when rtk is not installed", async () => {
    const hooks = createHookRegistry();
    installRtkRewrite(hooks, () => false);

    const result = await hooks.fireHook(
      "before_tool",
      { id: "tc1", name: "bash", args: { command: "git log" } },
      { cwd: "/tmp", messages: [] },
    );

    expect(result).toBeUndefined();
  });

  it("rewrites supported bash commands when rtk is installed", async () => {
    const hooks = createHookRegistry();
    installRtkRewrite(hooks, () => true);

    const result = await hooks.fireHook(
      "before_tool",
      { id: "tc1", name: "bash", args: { command: "git log --oneline" } },
      { cwd: "/tmp", messages: [] },
    );

    expect(result).toEqual({ args: { command: "rtk git log --oneline" } });
  });

  it("skips commands already prefixed with rtk", async () => {
    const hooks = createHookRegistry();
    installRtkRewrite(hooks, () => true);

    const result = await hooks.fireHook(
      "before_tool",
      { id: "tc1", name: "bash", args: { command: "rtk git log" } },
      { cwd: "/tmp", messages: [] },
    );

    expect(result).toBeUndefined();
  });
});
