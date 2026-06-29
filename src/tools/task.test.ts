import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate config reads from the developer's real ~/.orin/config.json so tests
// that call hasE2BApiKey()/loadConfig() see an empty config, not saved keys.
let configHome: string;
let prevHome: string | undefined;

beforeEach(async () => {
  prevHome = process.env.HOME;
  configHome = mkdtempSync(join(tmpdir(), "orin-task-test-"));
  process.env.HOME = configHome;
  const { __testClearCache } = await import("../config/config.js");
  __testClearCache();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(configHome, { recursive: true, force: true });
});
import { createHookRegistry } from "../hooks/registry.js";
import { installCoreHooks } from "../hooks/install.js";
import type { ApprovalGateRef } from "../hooks/approval-gate.js";
import { createFauxProvider, createStatefulFauxProvider } from "../provider/faux.js";
import type { StreamAssistantFn } from "../provider/types.js";
import { getChildTools, getCoreTools } from "./registry.js";
import { runParallelTasks, runSubagentTask, taskParallelTool, taskTool } from "./task.js";
import type { AgentContext, LoopHost } from "../types.js";
import { createLocalWorkspace } from "../workspace/local.js";
import { runLoop } from "../agent/loop.js";
import { installTelemetry } from "../telemetry/install.js";
import type { MetricSink } from "../telemetry/sinks.js";
import type { SessionCostSummary } from "../telemetry/events.js";

function loopHost(provider: ReturnType<typeof createStatefulFauxProvider>, tools = getCoreTools()): LoopHost {
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

  it("returns a partial summary instead of throwing when the child loop errors", async () => {
    let calls = 0;
    // Turn 1 reports a finding and keeps exploring; turn 2 simulates the provider
    // rejecting an over-window request. The subagent must surface the partial
    // finding to the parent, not propagate a raw error (#183).
    const provider: StreamAssistantFn = (messages, options, emit) => {
      calls += 1;
      if (calls === 1) {
        return createFauxProvider({
          text: ["Partial findings: inspected the entry point."],
          toolCalls: [{ id: "ls1", name: "ls", arguments: { path: "." } }],
          model: options.model,
        })(messages, options, emit);
      }
      throw new Error("context length exceeded");
    };

    const ctx = baseCtx({ loopHost: loopHost(provider, getChildTools()) });

    const result = await runSubagentTask(
      { description: "scan", prompt: "explore the repo", agent: "explore" },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("stopped early");
    expect(result.output).toContain("Partial findings");
    expect(result.output).toContain("context length exceeded");
  });

  it("propagates cancellation rather than swallowing it as a partial result", async () => {
    const controller = new AbortController();
    const provider: StreamAssistantFn = (messages, options, emit) => {
      controller.abort();
      // The loop checks the signal and ends cleanly; this asserts an aborted run
      // is not reported as an errored exploration.
      return createFauxProvider({ text: ["interrupted"], model: options.model })(
        messages,
        options,
        emit,
      );
    };
    const ctx = baseCtx({ loopHost: loopHost(provider, getChildTools()) });

    const result = await runSubagentTask(
      { description: "scan", prompt: "explore", agent: "explore" },
      ctx,
      controller.signal,
    );
    expect(result.output).not.toContain("stopped early");
  });

  it("implement defaults to shared and persists edits to the local tree (no E2B)", async () => {
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

  it("uses the session worktree when the parent already runs in worktree mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orin-parent-wt-"));
    const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    try {
      g("init", "-q");
      g("config", "user.email", "t@t");
      g("config", "user.name", "t");
      writeFileSync(join(dir, "seed.txt"), "base");
      g("add", "-A");
      g("commit", "-q", "-m", "base");

      const { bootstrapSessionWorktree } = await import("../workspace/session-worktree.js");
      const wt = bootstrapSessionWorktree(dir, randomUUID());
      if (!("binding" in wt)) throw new Error("expected session worktree");

      const provider = createStatefulFauxProvider([
        { toolCalls: [{ id: "w1", name: "write", arguments: { path: "child.txt", content: "in session branch" } }] },
        { text: ["Done"] },
      ]);
      const host = loopHost(provider, getChildTools());
      host.sessionIsolation = "worktree";
      host.hostCwd = dir;
      const ctx = baseCtx({ cwd: wt.binding.handle.cwd, loopHost: host });

      const result = await runSubagentTask(
        { description: "edit", prompt: "add child.txt", agent: "implement", isolation: "worktree" },
        ctx,
        new AbortController().signal,
      );

      expect(result.isError).toBeFalsy();
      expect(existsSync(join(wt.binding.handle.cwd, "child.txt"))).toBe(true);
      expect(existsSync(join(dir, "child.txt"))).toBe(false);
      expect(g("branch", "--list", "orin/subagent-*").trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parallel subagent worktrees branch from the session tip, not host HEAD", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orin-par-session-wt-"));
    const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    const gs = (sessionCwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", sessionCwd, ...args], { encoding: "utf8" });
    try {
      g("init", "-q");
      g("config", "user.email", "t@t");
      g("config", "user.name", "t");
      writeFileSync(join(dir, "seed.txt"), "base");
      g("add", "-A");
      g("commit", "-q", "-m", "base");

      const { bootstrapSessionWorktree } = await import("../workspace/session-worktree.js");
      const wt = bootstrapSessionWorktree(dir, randomUUID());
      if (!("binding" in wt)) throw new Error("expected session worktree");
      const sessionCwd = wt.binding.handle.cwd;
      const sessionBranch = wt.binding.branch;

      writeFileSync(join(sessionCwd, "session-only.txt"), "session work");
      gs(sessionCwd, "add", "-A");
      gs(sessionCwd, "commit", "-q", "-m", "session work");

      const provider: StreamAssistantFn = (messages, options, emit) => {
        const text = messages
          .flatMap((m) => m.content.map((c) => (c.type === "text" ? c.text : "")))
          .join(" ");
        const file = text.includes("child.txt") ? "child.txt" : "other.txt";
        const wroteAlready = messages.some((m) => m.role === "tool");
        return createFauxProvider(
          wroteAlready
            ? { text: ["Done"], model: options.model }
            : {
                toolCalls: [{ id: "w1", name: "write", arguments: { path: file, content: "from subagent" } }],
                model: options.model,
              },
        )(messages, options, emit);
      };
      const host = loopHost(provider, getChildTools());
      host.sessionIsolation = "worktree";
      host.hostCwd = dir;
      host.sessionBranch = sessionBranch;
      const ctx = baseCtx({ cwd: sessionCwd, loopHost: host });

      const result = await runParallelTasks(
        {
          tasks: [
            { description: "edit A", prompt: "add child.txt", agent: "implement" },
            { description: "edit B", prompt: "add other.txt", agent: "implement" },
          ],
        },
        ctx,
        new AbortController().signal,
      );

      expect(result.isError).toBeFalsy();
      expect(existsSync(join(sessionCwd, "child.txt"))).toBe(false);
      const subagentBranch = g("branch", "--list", "orin/subagent-*")
        .split("\n")
        .map((b) => b.replace(/^\*?\s*/, ""))
        .filter(Boolean)[0];
      expect(subagentBranch).toBeTruthy();
      expect(g("show", `${subagentBranch}:session-only.txt`)).toContain("session work");
      expect(g("show", `${subagentBranch}:child.txt`)).toContain("from subagent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escalates to the config isolation floor when the model requests less", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ subagent: { isolation: "worktree" } });
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
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the worktree (skips remove) when harvest fails to commit", async () => {
    const remove = vi.fn(() => {});
    const harvest = vi.fn(() => ({ branch: "orin/subagent-deadbeef", error: "commit blocked" }));
    const fakeWorktree = {
      createWorktree: () => ({
        handle: {
          workspace: createLocalWorkspace(),
          cwd: process.cwd(),
          branch: "orin/subagent-deadbeef",
          hostCwd: process.cwd(),
          harvest,
          remove,
        },
      }),
    };

    const provider = createStatefulFauxProvider([{ text: ["did work"] }]);
    const ctx = baseCtx({ loopHost: loopHost(provider, getChildTools()) });

    const result = await runSubagentTask(
      { description: "work", prompt: "do it", agent: "implement", isolation: "worktree" },
      ctx,
      new AbortController().signal,
      fakeWorktree,
    );

    expect(result.isError).toBeFalsy();
    expect(harvest).toHaveBeenCalledOnce();
    // Commit failed → the worktree must NOT be removed, so the work is recoverable.
    expect(remove).not.toHaveBeenCalled();
    expect(result.output).toContain("Could not commit");
    expect(result.output).toContain("recovered");
  });

  it("runs implement subagent in a sandbox and disposes the workspace", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ sandbox: { e2b: { apiKey: "test-key" } } });
    const dispose = vi.fn(async () => {});
    const exec = vi.fn(async () => ({ exitCode: 0 }));
    const sandbox = {
      kind: "e2b" as const,
      exec,
      readFile: async () => "",
      writeFile: async () => {},
      list: async () => [],
      stat: async () => null,
      deleteFile: async () => {},
      move: async () => {},
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
  });

  it("rejects sandbox isolation without an E2B API key", async () => {
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
    expect(result.output).toContain("E2B is not configured");
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

  it("forwards a subagent's propose_todo to the parent hooks (issue #149)", async () => {
    // Implement a small provider that calls propose_todo on its first turn and
    // wraps up on the second. The forwarded todo_proposal should land on the
    // parent registry tagged with the subagent id, ready for the session to
    // apply to the parent's todos.
    const proposed = [
      { id: "p1", content: "Surface blocker", status: "in_progress" as const },
      { id: "p2", content: "Add regression test", status: "pending" as const },
    ];

    const provider: StreamAssistantFn = (messages, options, emit) => {
      const sawToolResult = messages.some((m) => m.role === "tool");
      if (!sawToolResult) {
        return createFauxProvider({
          toolCalls: [
            { id: "prop1", name: "propose_todo", arguments: { todos: proposed } },
          ],
          model: options.model,
        })(messages, options, emit);
      }
      return createFauxProvider({ text: ["Proposed plan update"], model: options.model })(
        messages,
        options,
        emit,
      );
    };

    const parentHooks = createHookRegistry();
    const approval: ApprovalGateRef = {
      mode: "auto-accept",
      autoAcceptCli: true,
      tools: getChildTools(),
    };
    installCoreHooks(parentHooks, approval);

    const proposals: Array<{ todos: unknown; subagentId?: string }> = [];
    parentHooks.observe((event) => {
      if (event.type === "todo_proposal") proposals.push(event);
    });

    // Pre-seed the parent with its own list — the subagent should not see this
    // touched. The proposal is the *new* list the parent should adopt.
    const parentTodos = [{ id: "orig", content: "Original parent task", status: "pending" as const }];

    const ctx = baseCtx({
      loopHost: {
        provider,
        model: "faux:test",
        hooks: parentHooks,
        approval,
      },
    });
    ctx.todos = parentTodos;

    const result = await runSubagentTask(
      { description: "discover work", prompt: "investigate and propose a plan update", agent: "implement" },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBeFalsy();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.todos).toEqual(proposed);
    expect(proposals[0]?.subagentId).toBeTruthy();
    // Child must not have mutated the parent's list — the proposal is a forward
    // event only. The parent session is responsible for applying it.
    expect(ctx.todos).toBe(parentTodos);
  });

  it("runs the child loop on the role-resolved model (explore→explore slot, review→main slot)", async () => {
    const { saveProviderModelSlot, __testClearCache } = await import("../config/config.js");
    saveProviderModelSlot("openrouter", "main", "z-ai/glm-5.1");
    saveProviderModelSlot("openrouter", "explore", "minimax/minimax-m3");
    __testClearCache();

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
    expect(exploreTurns.every((m) => m === "minimax/minimax-m3")).toBe(true);

    const reviewTurns = await modelsForAgent("review");
    expect(reviewTurns.length).toBeGreaterThanOrEqual(1);
    expect(reviewTurns.every((m) => m === "z-ai/glm-5.1")).toBe(true);
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
      pricing: { "deepseek/deepseek-v4-flash": { inputPerM: 1, outputPerM: 1 } },
    });

    const { saveProviderModelSlot, __testClearCache } = await import("../config/config.js");
    saveProviderModelSlot("openrouter", "explore", "deepseek/deepseek-v4-flash");
    __testClearCache();

    const ctx = baseCtx({
      loopHost: { provider, model: "faux:test", hooks: parentHooks, approval },
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
    expect(summary?.modelMix["deepseek/deepseek-v4-flash"]?.turns).toBe(turns.length);
  });
});

describe("runParallelTasks", () => {
  it("fans out N children, each in its own worktree branch, leaving the host tree clean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orin-par-wt-"));
    const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    try {
      g("init", "-q");
      g("config", "user.email", "t@t");
      g("config", "user.name", "t");
      writeFileSync(join(dir, "seed.txt"), "base");
      g("add", "-A");
      g("commit", "-q", "-m", "base");

      // Each child writes a distinct file. A prompt-aware provider keeps the two
      // concurrent children deterministic regardless of interleaving: each writes
      // the file named in its own prompt, then summarizes once the write is done.
      const provider: StreamAssistantFn = (messages, options, emit) => {
        const text = messages
          .flatMap((m) => m.content.map((c) => (c.type === "text" ? c.text : "")))
          .join(" ");
        const file = text.includes("a.txt") ? "a.txt" : "b.txt";
        const wroteAlready = messages.some((m) => m.role === "tool");
        const script = wroteAlready
          ? { text: [`wrote ${file}`], model: options.model }
          : {
              toolCalls: [{ id: "w", name: "write", arguments: { path: file, content: file } }],
              model: options.model,
            };
        return createFauxProvider(script)(messages, options, emit);
      };
      const ctx = baseCtx({ cwd: dir, loopHost: loopHost(provider, getChildTools()) });

      const result = await runParallelTasks(
        {
          tasks: [
            { description: "task A", prompt: "create a.txt", agent: "implement" },
            { description: "task B", prompt: "create b.txt", agent: "implement" },
          ],
        },
        ctx,
        new AbortController().signal,
      );

      expect(result.isError).toBeFalsy();
      expect(result.output).toContain("Parallel fan-out: 2 subagents");
      expect(result.output).toContain("### 1. task A");
      expect(result.output).toContain("### 2. task B");
      // Neither child wrote to the host working tree.
      expect(existsSync(join(dir, "a.txt"))).toBe(false);
      expect(existsSync(join(dir, "b.txt"))).toBe(false);
      // Two distinct subagent branches were created, one per child.
      const branches = g("branch", "--list", "orin/subagent-*")
        .split("\n")
        .map((b) => b.replace(/^\*?\s*/, ""))
        .filter(Boolean);
      expect(branches).toHaveLength(2);
      // Each child's write landed on its own branch — both files exist, on
      // separate branches, never on the host tree.
      const filesAcrossBranches = branches.flatMap((b) =>
        g("ls-tree", "--name-only", b).split("\n").filter(Boolean),
      );
      expect(filesAcrossBranches).toContain("a.txt");
      expect(filesAcrossBranches).toContain("b.txt");
      // Worktree dirs were cleaned up — only the main worktree remains.
      const worktrees = g("worktree", "list").trim().split("\n").filter(Boolean);
      expect(worktrees).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("task_parallel includes uncommitted parent work on the host tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orin-par-wip-"));
    const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    try {
      g("init", "-q");
      g("config", "user.email", "t@t");
      g("config", "user.name", "t");
      writeFileSync(join(dir, "seed.txt"), "base");
      g("add", "-A");
      g("commit", "-q", "-m", "base");
      writeFileSync(join(dir, "wip.txt"), "uncommitted parent work");

      const provider: StreamAssistantFn = (messages, options, emit) => {
        const text = messages
          .flatMap((m) => m.content.map((c) => (c.type === "text" ? c.text : "")))
          .join(" ");
        const file = text.includes("a.txt") ? "a.txt" : "b.txt";
        const wroteAlready = messages.some((m) => m.role === "tool");
        return createFauxProvider(
          wroteAlready
            ? { text: [`wrote ${file}`], model: options.model }
            : {
                toolCalls: [{ id: "w", name: "write", arguments: { path: file, content: file } }],
                model: options.model,
              },
        )(messages, options, emit);
      };
      const ctx = baseCtx({ cwd: dir, loopHost: loopHost(provider, getChildTools()) });

      const result = await runParallelTasks(
        {
          tasks: [
            { description: "task A", prompt: "create a.txt", agent: "implement" },
            { description: "task B", prompt: "create b.txt", agent: "implement" },
          ],
        },
        ctx,
        new AbortController().signal,
      );

      expect(result.isError).toBeFalsy();
      expect(existsSync(join(dir, "a.txt"))).toBe(false);
      expect(existsSync(join(dir, "b.txt"))).toBe(false);
      expect(existsSync(join(dir, "wip.txt"))).toBe(true);
      const branches = g("branch", "--list", "orin/subagent-*")
        .split("\n")
        .map((b) => b.replace(/^\*?\s*/, ""))
        .filter(Boolean);
      expect(branches).toHaveLength(2);
      for (const branch of branches) {
        expect(g("show", `${branch}:wip.txt`)).toContain("uncommitted parent work");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("task_parallel branches mutating children from the session tip when parent uses a session worktree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orin-par-session-"));
    const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    const gs = (sessionCwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", sessionCwd, ...args], { encoding: "utf8" });
    try {
      g("init", "-q");
      g("config", "user.email", "t@t");
      g("config", "user.name", "t");
      writeFileSync(join(dir, "seed.txt"), "base");
      g("add", "-A");
      g("commit", "-q", "-m", "base");

      const { bootstrapSessionWorktree } = await import("../workspace/session-worktree.js");
      const wt = bootstrapSessionWorktree(dir, randomUUID());
      if (!("binding" in wt)) throw new Error("expected session worktree");
      const sessionCwd = wt.binding.handle.cwd;
      const sessionBranch = wt.binding.branch;

      writeFileSync(join(sessionCwd, "session-only.txt"), "session work");
      gs(sessionCwd, "add", "-A");
      gs(sessionCwd, "commit", "-q", "-m", "session work");

      const provider: StreamAssistantFn = (messages, options, emit) => {
        const text = messages
          .flatMap((m) => m.content.map((c) => (c.type === "text" ? c.text : "")))
          .join(" ");
        const file = text.includes("a.txt") ? "a.txt" : "b.txt";
        const wroteAlready = messages.some((m) => m.role === "tool");
        return createFauxProvider(
          wroteAlready
            ? { text: [`wrote ${file}`], model: options.model }
            : {
                toolCalls: [{ id: "w", name: "write", arguments: { path: file, content: file } }],
                model: options.model,
              },
        )(messages, options, emit);
      };
      const host = loopHost(provider, getChildTools());
      host.sessionIsolation = "worktree";
      host.hostCwd = dir;
      host.sessionBranch = sessionBranch;
      const ctx = baseCtx({ cwd: sessionCwd, loopHost: host });

      const result = await runParallelTasks(
        {
          tasks: [
            { description: "task A", prompt: "create a.txt", agent: "implement" },
            { description: "task B", prompt: "create b.txt", agent: "implement" },
          ],
        },
        ctx,
        new AbortController().signal,
      );

      expect(result.isError).toBeFalsy();
      expect(existsSync(join(sessionCwd, "a.txt"))).toBe(false);
      expect(existsSync(join(sessionCwd, "b.txt"))).toBe(false);
      const branches = g("branch", "--list", "orin/subagent-*")
        .split("\n")
        .map((b) => b.replace(/^\*?\s*/, ""))
        .filter(Boolean);
      expect(branches).toHaveLength(2);
      for (const branch of branches) {
        expect(g("show", `${branch}:session-only.txt`)).toContain("session work");
      }
      const filesAcrossBranches = branches.flatMap((b) =>
        g("ls-tree", "--name-only", b).split("\n").filter(Boolean),
      );
      expect(filesAcrossBranches).toContain("a.txt");
      expect(filesAcrossBranches).toContain("b.txt");
      // Session branch itself was not written to — only subagent branches were.
      expect(gs(sessionCwd, "status", "--porcelain")).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs read-only children in parallel on the shared tree (no worktree needed)", async () => {
    // A shared turn counter would interleave nondeterministically across the two
    // concurrent children, so drive each from its own prompt: ls first, then a
    // summary tagged with the child's label once the tool result is in context.
    const provider: StreamAssistantFn = (messages, options, emit) => {
      const text = messages
        .flatMap((m) => m.content.map((c) => (c.type === "text" ? c.text : "")))
        .join(" ");
      const label = text.includes("scan one") ? "one" : "two";
      const sawToolResult = messages.some((m) => m.role === "tool");
      return createFauxProvider(
        sawToolResult
          ? { text: [`explore ${label} done`], model: options.model }
          : {
              toolCalls: [{ id: `ls-${label}`, name: "ls", arguments: { path: "." } }],
              model: options.model,
            },
      )(messages, options, emit);
    };
    const ctx = baseCtx({ loopHost: loopHost(provider, getChildTools()) });

    const result = await runParallelTasks(
      {
        tasks: [
          { description: "scan one", prompt: "scan one: what's here?", agent: "explore" },
          { description: "scan two", prompt: "scan two: what's here?", agent: "explore" },
        ],
      },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("explore one done");
    expect(result.output).toContain("explore two done");
  });

  it("bounds concurrency to subagent.maxParallel", async () => {
    const { saveConfig, __testClearCache } = await import("../config/config.js");
    saveConfig({ subagent: { maxParallel: 2 } });
    __testClearCache();

    let active = 0;
    let peak = 0;
    // Each child's single provider call holds a slot briefly so overlapping
    // children are observable; the pool must cap simultaneous workers at 2.
    const provider: StreamAssistantFn = async (messages, options, emit) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      return createFauxProvider({ text: ["done"], model: options.model })(messages, options, emit);
    };
    const ctx = baseCtx({ loopHost: loopHost(provider, getChildTools()) });

    const result = await runParallelTasks(
      {
        tasks: Array.from({ length: 4 }, (_, i) => ({
          description: `scan ${i}`,
          prompt: "look",
          agent: "explore" as const,
        })),
      },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBeFalsy();
    expect(peak).toBeLessThanOrEqual(2);
    // 4 tasks with 2 workers should actually reach the cap.
    expect(peak).toBe(2);
    expect(result.output).toContain("≤2 at once");
  });

  it("disposes every child workspace when children run in sandboxes", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ sandbox: { e2b: { apiKey: "test-key" } } });
    const dispose = vi.fn(async () => {});
    const makeSandbox = () => ({
      kind: "e2b" as const,
      exec: async () => ({ exitCode: 0 }),
      readFile: async () => "",
      writeFile: async () => {},
      list: async () => [],
      stat: async () => null,
      deleteFile: async () => {},
      move: async () => {},
      dispose,
    });

    const provider = createStatefulFauxProvider([
      { text: ["sandbox one done"] },
      { text: ["sandbox two done"] },
    ]);
    const ctx = baseCtx({ loopHost: loopHost(provider) });

    const result = await runParallelTasks(
      {
        tasks: [
          { description: "one", prompt: "do one", agent: "implement", isolation: "sandbox" },
          { description: "two", prompt: "do two", agent: "implement", isolation: "sandbox" },
        ],
      },
      ctx,
      new AbortController().signal,
      { createSandbox: async () => makeSandbox(), seedRepo: async () => "Cloned repo into sandbox" },
    );

    expect(result.isError).toBeFalsy();
    // Each child owns and disposes its own sandbox.
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("isolates a child that throws during setup, preserving sibling output", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ sandbox: { e2b: { apiKey: "test-key" } } });

    // The sandbox child throws while booting its workspace; the explore child
    // runs to completion. The pool must not let the throw reject Promise.all.
    const provider = createStatefulFauxProvider([{ text: ["explore survived"] }]);
    const ctx = baseCtx({ loopHost: loopHost(provider, getChildTools()) });

    const result = await runParallelTasks(
      {
        tasks: [
          { description: "ok", prompt: "look around", agent: "explore" },
          { description: "boom", prompt: "do risky", agent: "implement", isolation: "sandbox" },
        ],
      },
      ctx,
      new AbortController().signal,
      {
        createSandbox: async () => {
          throw new Error("sandbox boot failed");
        },
      },
    );

    // One child failed, the other succeeded → partial result, not a total failure.
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("explore survived");
    expect(result.output).toContain("Subagent failed before returning a summary");
    expect(result.output).toContain("sandbox boot failed");
  });

  it("blocks recursion beyond max depth before fanning out", async () => {
    const provider = createStatefulFauxProvider([{ text: ["unused"] }]);
    const ctx = baseCtx({ loopHost: loopHost(provider), depth: 1 });

    const result = await runParallelTasks(
      {
        tasks: [
          { description: "a", prompt: "x", agent: "explore" },
          { description: "b", prompt: "y", agent: "explore" },
        ],
      },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("recursion limit");
  });

  it("flags a tool error only when every child fails, not on partial failure", async () => {
    // No E2B key configured, so sandbox children fail; explore children succeed.
    const provider = createStatefulFauxProvider([
      { text: ["explore ok"] },
      { text: ["explore ok"] },
    ]);
    const ctx = baseCtx({ loopHost: loopHost(provider, getChildTools()) });

    const allFail = await runParallelTasks(
      {
        tasks: [
          { description: "s1", prompt: "x", agent: "implement", isolation: "sandbox" },
          { description: "s2", prompt: "y", agent: "implement", isolation: "sandbox" },
        ],
      },
      ctx,
      new AbortController().signal,
    );
    expect(allFail.isError).toBe(true);
    expect(allFail.output).toContain("2 reported an error");

    const partial = await runParallelTasks(
      {
        tasks: [
          { description: "ok", prompt: "look", agent: "explore" },
          { description: "bad", prompt: "y", agent: "implement", isolation: "sandbox" },
        ],
      },
      ctx,
      new AbortController().signal,
    );
    // One child succeeded → the fan-out is not a total failure.
    expect(partial.isError).toBeFalsy();
    expect(partial.output).toContain("1 reported an error");
    expect(partial.output).toContain("explore ok");
  });

  it("exposes the task_parallel tool", () => {
    expect(taskParallelTool.name).toBe("task_parallel");
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
