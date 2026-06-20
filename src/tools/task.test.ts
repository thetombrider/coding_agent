import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHookRegistry } from "../hooks/registry.js";
import { installCoreHooks } from "../hooks/install.js";
import type { ApprovalGateRef } from "../hooks/approval-gate.js";
import { createStatefulFauxProvider } from "../provider/faux.js";
import { getChildTools, getCoreTools } from "./registry.js";
import { runSubagentTask, taskTool } from "./task.js";
import type { AgentContext } from "../types.js";
import { createLocalWorkspace } from "../workspace/local.js";
import { runLoop } from "../agent/loop.js";
import { installTelemetry } from "../telemetry/install.js";
import type { MetricSink } from "../telemetry/sinks.js";
import type { SessionCostSummary } from "../telemetry/events.js";

function loopHost(provider: ReturnType<typeof createStatefulFauxProvider>, tools = getCoreTools()) {
  const hooks = createHookRegistry();
  const approval: ApprovalGateRef = {
    mode: "auto-accept",
    autoAcceptCli: true,
    tools,
  };
  installCoreHooks(hooks, approval);
  return {
    provider,
    model: "faux:test",
    hooks,
    approval,
  };
}

function baseCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    cwd: process.cwd(),
    messages: [],
    workspace: createLocalWorkspace(),
    depth: 0,
    ...overrides,
  };
}

describe("runSubagentTask", () => {
  it("runs an explore subagent on the shared workspace and returns a summary", async () => {
    const provider = createStatefulFauxProvider([
      { toolCalls: [{ id: "ls1", name: "ls", arguments: { path: "." } }] },
      { text: ["Found package.json and src/."] },
    ]);

    const ctx = baseCtx({
      loopHost: loopHost(provider, getChildTools()),
    });

    const result = await runSubagentTask(
      { description: "scan repo", prompt: "what files exist?", agent: "explore" },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("Subagent (explore) finished");
    expect(result.output).toContain("package.json");
  });

  it("implement defaults to shared and persists edits to the local tree (no E2B)", async () => {
    vi.stubEnv("E2B_API_KEY", "");
    const dir = mkdtempSync(join(tmpdir(), "orin-shared-"));
    try {
      const provider = createStatefulFauxProvider([
        { toolCalls: [{ id: "w1", name: "write", arguments: { path: "out.txt", content: "persisted" } }] },
        { text: ["Wrote out.txt"] },
      ]);
      const ctx = baseCtx({ cwd: dir, loopHost: loopHost(provider, getChildTools()) });

      const result = await runSubagentTask(
        { description: "edit", prompt: "create out.txt", agent: "implement" },
        ctx,
        new AbortController().signal,
      );

      expect(result.isError).toBeFalsy();
      expect(result.output).toContain("Subagent (implement) finished");
      // The edit landed on the real local tree and survives the subagent.
      expect(existsSync(join(dir, "out.txt"))).toBe(true);
      expect(readFileSync(join(dir, "out.txt"), "utf8")).toBe("persisted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it("worktree isolation runs on a branch, persists there, and leaves the host tree clean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orin-wt-host-"));
    const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    try {
      g("init", "-q");
      g("config", "user.email", "t@t");
      g("config", "user.name", "t");
      writeFileSync(join(dir, "seed.txt"), "base");
      g("add", "-A");
      g("commit", "-q", "-m", "base");

      const provider = createStatefulFauxProvider([
        { toolCalls: [{ id: "w1", name: "write", arguments: { path: "child.txt", content: "from worktree" } }] },
        { text: ["Added child.txt"] },
      ]);
      const ctx = baseCtx({ cwd: dir, loopHost: loopHost(provider, getChildTools()) });

      const result = await runSubagentTask(
        { description: "branch work", prompt: "add child.txt", agent: "implement", isolation: "worktree" },
        ctx,
        new AbortController().signal,
      );

      expect(result.isError).toBeFalsy();
      expect(result.output).toMatch(/branch `orin\/subagent-/);
      // Host working tree is untouched — the edit lives only on the branch.
      expect(existsSync(join(dir, "child.txt"))).toBe(false);
      const branch = g("branch", "--list", "orin/subagent-*").trim();
      expect(branch).not.toBe("");
      // The branch carries the committed change.
      const branchName = branch.replace(/^\*?\s*/, "");
      expect(g("show", `${branchName}:child.txt`).trim()).toBe("from worktree");
      // The worktree dir was cleaned up — only the main worktree remains.
      const worktrees = g("worktree", "list").trim().split("\n").filter(Boolean);
      expect(worktrees).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escalates to the config isolation floor when the model requests less", async () => {
    // Floor = worktree via env override; an implement task with no isolation arg
    // (would default to shared) must be clamped up to worktree.
    vi.stubEnv("ORIN_SUBAGENT_ISOLATION", "worktree");
    const dir = mkdtempSync(join(tmpdir(), "orin-wt-floor-"));
    const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    try {
      g("init", "-q");
      g("config", "user.email", "t@t");
      g("config", "user.name", "t");
      writeFileSync(join(dir, "seed.txt"), "base");
      g("add", "-A");
      g("commit", "-q", "-m", "base");

      const provider = createStatefulFauxProvider([
        { toolCalls: [{ id: "w1", name: "write", arguments: { path: "child.txt", content: "floored" } }] },
        { text: ["done"] },
      ]);
      const ctx = baseCtx({ cwd: dir, loopHost: loopHost(provider, getChildTools()) });

      const result = await runSubagentTask(
        { description: "work", prompt: "add child.txt", agent: "implement" },
        ctx,
        new AbortController().signal,
      );

      expect(result.isError).toBeFalsy();
      expect(result.output).toMatch(/branch `orin\/subagent-/);
      // Ran on a branch, not the host tree.
      expect(existsSync(join(dir, "child.txt"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs implement subagent in a sandbox and disposes the workspace", async () => {
    vi.stubEnv("E2B_API_KEY", "test-key");
    const dispose = vi.fn(async () => {});
    const exec = vi.fn(async () => ({ exitCode: 0 }));
    const sandbox = {
      kind: "e2b" as const,
      exec,
      readFile: async () => "",
      writeFile: async () => {},
      list: async () => [],
      dispose,
    };

    const provider = createStatefulFauxProvider([{ text: ["Edited README in sandbox."] }]);
    const ctx = baseCtx({ loopHost: loopHost(provider) });

    const result = await runSubagentTask(
      { description: "fix readme", prompt: "update readme", agent: "implement", isolation: "sandbox" },
      ctx,
      new AbortController().signal,
      {
        createSandbox: async () => sandbox,
        seedRepo: async () => "Cloned repo into sandbox",
      },
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("Subagent (implement) finished");
    expect(result.output).toContain("README");
    expect(dispose).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
  });

  it("rejects sandbox isolation without an E2B API key", async () => {
    vi.stubEnv("E2B_API_KEY", "");
    const provider = createStatefulFauxProvider([{ text: ["unused"] }]);
    const ctx = baseCtx({ loopHost: loopHost(provider) });

    const result = await runSubagentTask(
      {
        description: "review",
        prompt: "check code",
        agent: "implement",
        isolation: "sandbox",
      },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("E2B_API_KEY is not set");
    vi.unstubAllEnvs();
  });

  it("blocks recursion beyond max depth", async () => {
    const provider = createStatefulFauxProvider([{ text: ["unused"] }]);
    const ctx = baseCtx({ loopHost: loopHost(provider), depth: 1 });

    const result = await runSubagentTask(
      { description: "nested", prompt: "go deeper" },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("recursion limit");
  });

  it("forwards child tool events to the parent hooks with subagentId", async () => {
    const provider = createStatefulFauxProvider([
      { toolCalls: [{ id: "read1", name: "read", arguments: { path: "package.json" } }] },
      { text: ["done"] },
    ]);

    const parentHooks = createHookRegistry();
    const approval: ApprovalGateRef = {
      mode: "auto-accept",
      autoAcceptCli: true,
      tools: getChildTools(),
    };
    installCoreHooks(parentHooks, approval);

    const childEvents: Array<{ type: string; subagentId?: string }> = [];
    parentHooks.observe((event) => {
      if (
        event.type === "tool_start" ||
        event.type === "tool_end" ||
        event.type === "assistant_message" ||
        event.type === "llm_start"
      ) {
        childEvents.push({ type: event.type, subagentId: event.subagentId });
      }
    });

    const ctx = baseCtx({
      loopHost: {
        provider,
        model: "faux:test",
        hooks: parentHooks,
        approval,
      },
    });

    await runSubagentTask(
      { description: "read pkg", prompt: "read package.json", agent: "explore" },
      ctx,
      new AbortController().signal,
    );

    expect(childEvents.some((e) => e.type === "tool_start" && e.subagentId)).toBe(true);
    expect(childEvents.some((e) => e.type === "tool_end" && e.subagentId)).toBe(true);
    expect(childEvents.some((e) => e.type === "llm_start" && e.subagentId)).toBe(true);
    expect(childEvents.some((e) => e.type === "assistant_message" && e.subagentId)).toBe(true);
    // Every forwarded child event carries the subagentId tag.
    expect(childEvents.every((e) => Boolean(e.subagentId))).toBe(true);
  });

  it("runs the child loop on the role-resolved model (explore→cheap, review→main)", async () => {
    async function modelsForAgent(agent: "explore" | "review"): Promise<string[]> {
      const provider = createStatefulFauxProvider([{ text: ["done"] }]);
      const parentHooks = createHookRegistry();
      const approval: ApprovalGateRef = {
        mode: "auto-accept",
        autoAcceptCli: true,
        tools: getChildTools(),
      };
      installCoreHooks(parentHooks, approval);

      const turns: string[] = [];
      const sink: MetricSink = {
        emit(event) {
          if (event.type === "turn") turns.push(event.model);
        },
      };
      installTelemetry({
        hooks: parentHooks,
        sinks: [sink],
        sessionId: `s-${agent}`,
        pricing: {},
      });

      const ctx = baseCtx({
        loopHost: {
          provider,
          model: "main:test",
          cheapModel: "cheap:test",
          hooks: parentHooks,
          approval,
        },
      });

      await runSubagentTask(
        { description: "route", prompt: "investigate", agent },
        ctx,
        new AbortController().signal,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      await parentHooks.fireHook("session_end", { reason: "complete" }, ctx);
      return turns;
    }

    const exploreTurns = await modelsForAgent("explore");
    expect(exploreTurns.length).toBeGreaterThanOrEqual(1);
    expect(exploreTurns.every((m) => m === "cheap:test")).toBe(true);

    const reviewTurns = await modelsForAgent("review");
    expect(reviewTurns.length).toBeGreaterThanOrEqual(1);
    expect(reviewTurns.every((m) => m === "main:test")).toBe(true);
  });

  it("subagent LLM turns reach the parent accumulator tagged as subagent", async () => {
    const provider = createStatefulFauxProvider([
      { toolCalls: [{ id: "read1", name: "read", arguments: { path: "package.json" } }] },
      { text: ["done"] },
    ]);

    const parentHooks = createHookRegistry();
    const approval: ApprovalGateRef = {
      mode: "auto-accept",
      autoAcceptCli: true,
      tools: getChildTools(),
    };
    installCoreHooks(parentHooks, approval);

    const turns: Array<{ source: string; model: string }> = [];
    let summary: SessionCostSummary | undefined;
    const sink: MetricSink = {
      emit(event) {
        if (event.type === "turn") turns.push({ source: event.source, model: event.model });
        if (event.type === "session") summary = event.summary;
      },
    };
    installTelemetry({
      hooks: parentHooks,
      sinks: [sink],
      sessionId: "s-sub",
      pricing: { "faux:test": { inputPerM: 1, outputPerM: 1 } },
    });

    const ctx = baseCtx({
      // Pin cheapModel so the explore preset (cheap tier) still routes to faux:test.
      loopHost: { provider, model: "faux:test", cheapModel: "faux:test", hooks: parentHooks, approval },
    });

    await runSubagentTask(
      { description: "read pkg", prompt: "read package.json", agent: "explore" },
      ctx,
      new AbortController().signal,
    );
    // The observer schedules on a microtask; let forwarded events drain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await parentHooks.fireHook("session_end", { reason: "complete" }, ctx);

    // Two assistant turns in the child loop, both tagged subagent.
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(turns.every((t) => t.source === "subagent")).toBe(true);
    expect(summary?.sourceMix.subagent).toBe(turns.length);
    expect(summary?.modelMix["faux:test"]?.turns).toBe(turns.length);
  });
});

describe("task tool via runLoop", () => {
  it("parent agent can invoke task and receive the child summary", async () => {
    const provider = createStatefulFauxProvider([
      {
        toolCalls: [{
          id: "task1",
          name: "task",
          arguments: {
            description: "explore tree",
            prompt: "list top-level files",
            agent: "explore",
          },
        }],
      },
      { toolCalls: [{ id: "ls1", name: "ls", arguments: { path: "." } }] },
      { text: ["Found package.json"] },
      { text: ["The subagent found package.json."] },
    ]);

    const hooks = createHookRegistry();
    const tools = getCoreTools();
    installCoreHooks(hooks, { mode: "auto-accept", autoAcceptCli: true, tools });

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "explore the repo" }] }],
      workspace: createLocalWorkspace(),
      depth: 0,
      loopHost: {
        provider,
        model: "faux:test",
        hooks,
        approval: { mode: "auto-accept", autoAcceptCli: true, tools },
      },
    };

    await runLoop(ctx, hooks, { provider, tools, model: "faux:test" });
    expect(ctx.messages.some((m) => m.role === "tool")).toBe(true);
    expect(taskTool.name).toBe("task");
  });
});
