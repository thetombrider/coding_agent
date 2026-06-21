import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runLoop, lastAssistantText } from "../agent/loop.js";
import { createHookRegistry } from "../hooks/registry.js";
import type { AgentEvent } from "../agent/events.js";
import { installCoreHooks } from "../hooks/install.js";
import type { ApprovalGateRef } from "../hooks/approval-gate.js";
import { createStatefulFauxProvider } from "../provider/faux.js";
import { getCoreTools } from "../tools/registry.js";
import type { AnyTool } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import type { AgentContext, SessionEvent } from "../types.js";
import { createLocalWorkspace } from "../workspace/local.js";
import { INJECTION_MARKER } from "../prompt/inject.js";

describe("runLoop", () => {
  function hooks(tools: AnyTool[] = [], approval?: Partial<ApprovalGateRef>) {
    const registry = createHookRegistry();
    installCoreHooks(registry, {
      mode: "auto-accept",
      autoAcceptCli: true,
      tools,
      ...approval,
    });
    return registry;
  }
  it("executes read then completes on second turn", async () => {
    const provider = createStatefulFauxProvider([
      {
        toolCalls: [{ id: "tc1", name: "read", arguments: { path: "package.json" } }],
      },
      { text: ["Your package.json has 2 dependencies."] },
    ]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "what's in package.json and how many deps?" }],
        },
      ],
      workspace: createLocalWorkspace(),
    };

    const readTools = getCoreTools().filter((t) => t.name === "read");
    const result = await runLoop(ctx, hooks(readTools), {
      provider,
      tools: readTools,
      model: "faux:test",
    });

    expect(result.messages.some((m) => m.role === "tool")).toBe(true);
    expect(lastAssistantText(result)).toContain("2 dependencies");
  });

  it("emits one llm_start before each assistant_message sharing the same id", async () => {
    const provider = createStatefulFauxProvider([
      { toolCalls: [{ id: "tc1", name: "read", arguments: { path: "package.json" } }] },
      { text: ["done"] },
    ]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      workspace: createLocalWorkspace(),
    };

    const registry = hooks(getCoreTools().filter((t) => t.name === "read"));
    const observed: AgentEvent[] = [];
    registry.observe((e) => observed.push(e));

    const readTools = getCoreTools().filter((t) => t.name === "read");
    await runLoop(ctx, registry, { provider, tools: readTools, model: "faux:test" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const starts = observed.filter((e) => e.type === "llm_start");
    const messages = observed.filter((e) => e.type === "assistant_message");
    const turnStarts = observed.filter((e) => e.type === "turn_start");
    // Two LLM calls: the tool-call turn and the final text turn.
    expect(starts).toHaveLength(2);
    expect(messages).toHaveLength(2);
    expect(turnStarts).toHaveLength(1);
    expect(observed[0].type).toBe("turn_start");

    // Each assistant_message is preceded by an llm_start with the matching id.
    for (const msg of messages) {
      const id = msg.type === "assistant_message" ? msg.id : "";
      const startIdx = observed.findIndex((e) => e.type === "llm_start" && e.id === id);
      const msgIdx = observed.indexOf(msg);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(startIdx).toBeLessThan(msgIdx);
    }

    // Ids are unique per call.
    const ids = messages.map((m) => (m.type === "assistant_message" ? m.id : ""));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("calls onEvent with assistant_chunk and tool_result for each message pushed", async () => {
    const provider = createStatefulFauxProvider([
      { toolCalls: [{ id: "tc1", name: "read", arguments: { path: "package.json" } }] },
      { text: ["done"] },
    ]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      workspace: createLocalWorkspace(),
    };

    const readTools = getCoreTools().filter((t) => t.name === "read");
    const events: SessionEvent[] = [];
    await runLoop(ctx, hooks(readTools), {
      provider,
      tools: readTools,
      model: "faux:test",
      onEvent: (ev) => events.push(ev),
    });

    const types = events.map((e) => e.type);
    // First assistant response includes a tool call
    expect(types).toContain("assistant_chunk");
    // Tool result from the read call
    expect(types).toContain("tool_result");
    // Second assistant response (the final "done" text)
    expect(types.filter((t) => t === "assistant_chunk")).toHaveLength(2);
    expect(types.filter((t) => t === "tool_result")).toHaveLength(1);
  });

  it("onEvent is optional — loop runs normally without it", async () => {
    const provider = createStatefulFauxProvider([{ text: ["hello"] }]);
    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      workspace: createLocalWorkspace(),
    };
    await expect(runLoop(ctx, hooks(), { provider, tools: [], model: "faux:test" })).resolves.toBeDefined();
  });

  it("runs independent tool calls in parallel", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const slowTool = (name: string): Tool<{ n: number }> => ({
      name,
      description: "slow noop",
      schema: z.object({ n: z.number() }),
      async execute() {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 40));
        concurrent -= 1;
        return { output: "ok" };
      },
    });

    const provider = createStatefulFauxProvider([
      {
        toolCalls: [
          { id: "tc1", name: "slow_a", arguments: { n: 1 } },
          { id: "tc2", name: "slow_b", arguments: { n: 2 } },
          { id: "tc3", name: "slow_c", arguments: { n: 3 } },
        ],
      },
      { text: ["done"] },
    ]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      workspace: createLocalWorkspace(),
    };

    const slowTools = [slowTool("slow_a"), slowTool("slow_b"), slowTool("slow_c")];
    await runLoop(ctx, hooks(slowTools), {
      provider,
      tools: slowTools,
      model: "faux:test",
    });

    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it("serializes concurrent edits on the same file", async () => {
    const dir = join(tmpdir(), `orin-parallel-${Date.now()}`);
    const filePath = join(dir, "counter.txt");
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, "0\n", "utf8");

    const editCounter: Tool<{ path: string; delta: number }> = {
      name: "edit",
      description: "increment counter file",
      schema: z.object({ path: z.string(), delta: z.number() }),
      async execute({ path, delta }, ctx) {
        const fullPath = join(ctx.cwd, path);
        const current = Number((await readFile(fullPath, "utf8")).trim());
        await new Promise((r) => setTimeout(r, 30));
        await writeFile(fullPath, `${current + delta}\n`, "utf8");
        return { output: String(current + delta) };
      },
    };

    const provider = createStatefulFauxProvider([
      {
        toolCalls: [
          { id: "tc1", name: "edit", arguments: { path: "counter.txt", delta: 1 } },
          { id: "tc2", name: "edit", arguments: { path: "counter.txt", delta: 1 } },
          { id: "tc3", name: "edit", arguments: { path: "counter.txt", delta: 1 } },
        ],
      },
      { text: ["done"] },
    ]);

    const ctx: AgentContext = {
      cwd: dir,
      messages: [{ role: "user", content: [{ type: "text", text: "increment" }] }],
      workspace: createLocalWorkspace(),
    };

    await runLoop(ctx, hooks([editCounter]), {
      provider,
      tools: [editCounter],
      model: "faux:test",
    });

    const final = Number((await readFile(filePath, "utf8")).trim());
    expect(final).toBe(3);
    await rm(dir, { recursive: true, force: true });
  });

  it("executes read from XML embedded in faux assistant text", async () => {
    const provider = createStatefulFauxProvider([
      {
        text: ['<tool_call name="read"><path>package.json</path></tool_call>'],
      },
      { text: ["done"] },
    ]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "read package.json" }] }],
      workspace: createLocalWorkspace(),
    };

    const readTools = getCoreTools().filter((t) => t.name === "read");
    const result = await runLoop(ctx, hooks(readTools), {
      provider,
      tools: readTools,
      model: "faux:test",
    });

    expect(result.messages.some((m) => m.role === "tool")).toBe(true);
    const toolResult = result.messages.find((m) => m.role === "tool");
    const output = toolResult?.content.find((c) => c.type === "toolResult")?.output ?? "";
    expect(output).toContain("orin");
  });

  it("re-prompts when fallback-parsed tool args are invalid", async () => {
    let providerCalls = 0;
    const baseProvider = createStatefulFauxProvider([
      {
        text: ['<tool_call name="read"><wrong>package.json</wrong></tool_call>'],
      },
      {
        text: ['<tool_call name="read"><path>package.json</path></tool_call>'],
      },
      { text: ["done"] },
    ]);

    const provider: typeof baseProvider = (messages, options, emit) => {
      providerCalls += 1;
      return baseProvider(messages, options, emit);
    };

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "read file" }] }],
      workspace: createLocalWorkspace(),
    };

    const readTools = getCoreTools().filter((t) => t.name === "read");
    await runLoop(ctx, hooks(readTools), {
      provider,
      tools: readTools,
      model: "faux:test",
    });

    expect(providerCalls).toBeGreaterThanOrEqual(2);
    expect(ctx.messages.some((m) => m.role === "user" && m.content[0]?.type === "text" &&
      (m.content[0] as { text: string }).text.includes("invalid"))).toBe(true);
  });

  it("before_tool hook blocks dangerous bash commands", async () => {
    const executed: string[] = [];
    const bashTool: Tool<{ command: string }> = {
      name: "bash",
      description: "run shell",
      schema: z.object({ command: z.string() }),
      async execute({ command }) {
        executed.push(command);
        return { output: "ok" };
      },
    };

    const provider = createStatefulFauxProvider([
      { toolCalls: [{ id: "tc1", name: "bash", arguments: { command: "rm -rf /tmp/foo" } }] },
      { text: ["done"] },
    ]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "delete" }] }],
      workspace: createLocalWorkspace(),
    };

    const registry = hooks([bashTool]);
    registry.on("before_tool", ({ name, args }) => {
      if (name !== "bash") return;
      const command = (args as { command: string }).command;
      if (command.includes("rm -rf")) {
        return { block: true, reason: "rm -rf is not allowed" };
      }
    });

    await runLoop(ctx, registry, {
      provider,
      tools: [bashTool],
      model: "faux:test",
    });

    expect(executed).toHaveLength(0);
    const toolResult = ctx.messages.find((m) => m.role === "tool");
    const output = toolResult?.content.find((c) => c.type === "toolResult")?.output ?? "";
    expect(output).toContain("[Blocked: rm -rf is not allowed]");
  });

  it("before_tool hook rewrites args before execution", async () => {
    let executedCommand = "";
    const bashTool: Tool<{ command: string }> = {
      name: "bash",
      description: "run shell",
      schema: z.object({ command: z.string() }),
      async execute({ command }) {
        executedCommand = command;
        return { output: "ok" };
      },
    };

    const provider = createStatefulFauxProvider([
      { toolCalls: [{ id: "tc1", name: "bash", arguments: { command: "git log" } }] },
      { text: ["done"] },
    ]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "log" }] }],
      workspace: createLocalWorkspace(),
    };

    const registry = hooks([bashTool]);
    registry.on("before_tool", ({ name, args }) => {
      if (name !== "bash") return;
      const cmd = (args as { command: string }).command.trim();
      if (cmd.startsWith("git ") && !cmd.startsWith("rtk ")) {
        return { args: { command: `rtk ${cmd}` } };
      }
    });

    await runLoop(ctx, registry, {
      provider,
      tools: [bashTool],
      model: "faux:test",
    });

    expect(executedCommand).toBe("rtk git log");
  });

  it("before_prompt hook injects messages seen by the provider", async () => {
    let providerMessages: AgentContext["messages"] | undefined;
    const provider = createStatefulFauxProvider([{ text: ["hello"] }]);
    const wrappedProvider: typeof provider = (messages, options, emit) => {
      providerMessages = messages;
      return provider(messages, options, emit);
    };

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      workspace: createLocalWorkspace(),
    };

    const registry = hooks();
    registry.on("before_prompt", ({ messages }) => ({
      messages: [
        ...messages,
        { role: "user", content: [{ type: "text", text: "CONVENTIONS: use tabs" }] },
      ],
    })); // model is available but unused in this test

    await runLoop(ctx, registry, {
      provider: wrappedProvider,
      tools: [],
      model: "faux:test",
    });

    expect(providerMessages?.some((m) =>
      m.role === "user"
      && m.content.some((c) => c.type === "text" && c.text.includes("CONVENTIONS: use tabs")),
    )).toBe(true);
  });

  it("core hooks inject AGENTS.md and environment block each turn", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "loop-agents-"));
    await writeFile(join(cwd, "AGENTS.md"), "Always run tests after edits.");

    let providerMessages: AgentContext["messages"] | undefined;
    const provider = createStatefulFauxProvider([{ text: ["done"] }]);
    const wrappedProvider: typeof provider = (messages, options, emit) => {
      providerMessages = messages;
      return provider(messages, options, emit);
    };

    const ctx: AgentContext = {
      cwd,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      workspace: createLocalWorkspace(),
    };

    await runLoop(ctx, hooks(), {
      provider: wrappedProvider,
      tools: [],
      model: "faux:test-model",
    });

    const injected = providerMessages?.find(
      (m) =>
        m.role === "user"
        && m.content.some((c) => c.type === "text" && c.text.includes(INJECTION_MARKER)),
    );
    const text = injected?.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("<environment>");
    expect(text).toContain(`cwd: ${cwd}`);
    expect(text).toContain("model: faux:test-model");
    expect(text).toContain("Always run tests after edits.");
  });

  it("re-injects session todos each turn via before_prompt", async () => {
    let providerMessages: AgentContext["messages"] | undefined;
    const provider = createStatefulFauxProvider([{ text: ["done"] }]);
    const wrappedProvider: typeof provider = (messages, options, emit) => {
      providerMessages = messages;
      return provider(messages, options, emit);
    };

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      workspace: createLocalWorkspace(),
      todos: [
        { id: "1", content: "Ship feature", status: "in_progress" },
        { id: "2", content: "Write tests", status: "pending" },
      ],
    };

    await runLoop(ctx, hooks(), {
      provider: wrappedProvider,
      tools: [],
      model: "faux:test",
    });

    const injected = providerMessages?.find(
      (m) =>
        m.role === "user"
        && m.content.some((c) => c.type === "text" && c.text.includes("REMINDERS")),
    );
    const text = injected?.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("Ship feature");
    expect(text).toContain("Task progress: 0/2");
  });

  it("todowrite rejects multiple in_progress via the loop", async () => {
    const provider = createStatefulFauxProvider([
      {
        toolCalls: [{
          id: "tc1",
          name: "todowrite",
          arguments: {
            todos: [
              { id: "1", content: "A", status: "in_progress" },
              { id: "2", content: "B", status: "in_progress" },
            ],
          },
        }],
      },
      { text: ["ok"] },
    ]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "plan" }] }],
      workspace: createLocalWorkspace(),
    };

    const todowriteTools = getCoreTools().filter((t) => t.name === "todowrite");
    await runLoop(ctx, hooks(todowriteTools), {
      provider,
      tools: todowriteTools,
      model: "faux:test",
    });

    const toolMsg = ctx.messages.find((m) => m.role === "tool");
    const output = toolMsg?.content[0]?.type === "toolResult" ? toolMsg.content[0].output : "";
    expect(output).toContain("at most one todo");
  });

  it("stops cleanly when the turn signal is aborted mid-tool", async () => {
    const slowTool: Tool<{ n: number }> = {
      name: "slow",
      description: "slow noop",
      schema: z.object({ n: z.number() }),
      async execute(_args, _ctx, signal) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
        return { output: "ok" };
      },
    };

    const provider = createStatefulFauxProvider([
      { toolCalls: [{ id: "tc1", name: "slow", arguments: { n: 1 } }] },
      { text: ["done"] },
    ]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      workspace: createLocalWorkspace(),
    };

    const registry = hooks([slowTool]);
    const observed: AgentEvent[] = [];
    registry.observe((e) => observed.push(e));

    const abort = new AbortController();
    const loopPromise = runLoop(ctx, registry, {
      provider,
      tools: [slowTool],
      model: "faux:test",
      signal: abort.signal,
    });

    await new Promise((r) => setTimeout(r, 20));
    abort.abort();
    await loopPromise;

    expect(observed.some((e) => e.type === "loop_end" && e.reason === "cancelled")).toBe(true);
    expect(lastAssistantText(ctx)).toBe("");
  });
});
