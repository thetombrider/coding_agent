import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createHookRegistry } from "../hooks/registry.js";
import { installDelegateReadGate } from "../hooks/delegate-read-gate.js";
import { installRtkRewrite } from "../hooks/rtk-rewrite.js";
import type { Tool } from "../tools/types.js";
import { testAgentContext } from "../test-helpers.js";
import { OrinRatelBundle } from "./catalog.js";
import type { LoopHost } from "../types.js";

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({
    approval: { mode: "normal", autoApprovedCommands: [] },
  }),
}));

describe("invoke_tool hook propagation", () => {
  const readTool: Tool<{ path: string; offset?: number; limit?: number }> = {
    name: "read",
    description: "read file",
    schema: z.object({
      path: z.string(),
      offset: z.number().optional(),
      limit: z.number().optional(),
    }),
    async execute({ path }) {
      return { output: `contents of ${path}` };
    },
  };

  const bashTool: Tool<{ command: string }> = {
    name: "bash",
    description: "bash",
    schema: z.object({ command: z.string() }),
    needsApproval: () => true,
    async execute({ command }) {
      return { output: command };
    },
  };

  function loopHost(hooks: ReturnType<typeof createHookRegistry>): LoopHost {
    return {
      provider: async () => {
        throw new Error("not used");
      },
      model: "faux:test",
      hooks,
      approval: { mode: "normal", autoAcceptCli: false, tools: [readTool, bashTool] },
    };
  }

  it("runs delegate_read on the inner read tool", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orin-invoke-read-"));
    const big = "line\n".repeat(600);
    await writeFile(join(dir, "big.txt"), big, "utf8");

    const hooks = createHookRegistry();
    installDelegateReadGate(hooks);

    const bundle = OrinRatelBundle.build({
      tools: [readTool],
      cwd: dir,
      settings: {
        enabled: true,
        topKTools: 1,
        topKSkills: 1,
        pinnedTools: ["invoke_tool"],
        controlFraction: 0,
      },
    });

    const invoke = bundle.executionTools().find((t) => t.name === "invoke_tool");
    expect(invoke).toBeDefined();

    const ctx = testAgentContext(dir);
    ctx.loopHost = loopHost(hooks);
    ctx.invokeToolCallId = "tc-read";

    const result = await invoke!.execute(
      { toolId: "read", args: { path: "big.txt" } },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("too large for a direct read");
  });

  it("rewrites bash commands for inner invoke_tool calls", async () => {
    const hooks = createHookRegistry();
    installRtkRewrite(hooks, () => true);

    const bundle = OrinRatelBundle.build({
      tools: [bashTool],
      cwd: "/tmp",
      settings: {
        enabled: true,
        topKTools: 1,
        topKSkills: 1,
        pinnedTools: ["invoke_tool"],
        controlFraction: 0,
      },
    });

    const invoke = bundle.executionTools().find((t) => t.name === "invoke_tool");
    const ctx = testAgentContext("/tmp");
    ctx.loopHost = loopHost(hooks);
    ctx.invokeToolCallId = "tc-bash";

    const result = await invoke!.execute(
      { toolId: "bash", args: { command: "git status" } },
      ctx,
      new AbortController().signal,
    );

    expect(result.output).toBe("rtk git status");
  });
});
