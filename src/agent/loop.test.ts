import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runLoop, lastAssistantText } from "../agent/loop.js";
import { EMPTY_RESPONSE_MESSAGE } from "../agent/empty-response.js";
import * as compaction from "./compaction.js";
import * as contextWindow from "../provider/context-window.js";
import { createHookRegistry } from "../hooks/registry.js";
import type { AgentEvent } from "../agent/events.js";
import { installCoreHooks } from "../hooks/install.js";
import type { ApprovalGateRef } from "../hooks/approval-gate.js";
import { createStatefulFauxProvider } from "../provider/faux.js";
import type { StreamAssistantFn } from "../provider/types.js";
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

  it("re-prompts once on an empty assistant response, then surfaces a notice", async () => {
    const provider = createStatefulFauxProvider([{}, { text: ["recovered"] }]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      workspace: createLocalWorkspace(),
    };

    const registry = hooks();
    const observed: AgentEvent[] = [];
    registry.observe((e) => observed.push(e));

    await runLoop(ctx, registry, { provider, tools: [], model: "faux:test" });

    expect(lastAssistantText(ctx)).toBe("recovered");
    expect(ctx.messages.filter((m) => m.role === "user")).toHaveLength(2);
    expect(observed.some((e) => e.type === "text_delta" && e.text === "recovered")).toBe(true);
    expect(observed.some((e) => e.type === "loop_end" && e.reason === "complete")).toBe(true);
  });

  it("emits a synthetic assistant notice when the model stays empty after retry", async () => {
    const provider = createStatefulFauxProvider([{}, {}]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      workspace: createLocalWorkspace(),
    };

    const registry = hooks();
    const observed: AgentEvent[] = [];
    registry.observe((e) => observed.push(e));

    await runLoop(ctx, registry, { provider, tools: [], model: "faux:test" });

    expect(lastAssistantText(ctx)).toBe(EMPTY_RESPONSE_MESSAGE);
    expect(observed.some((e) => e.type === "text_delta" && e.text === EMPTY_RESPONSE_MESSAGE)).toBe(
      true,
    );
    expect(observed.some((e) => e.type === "loop_end" && e.reason === "complete")).toBe(true);
    expect(ctx.messages.at(-1)?.role).toBe("assistant");
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

  it("reads the result of a write to the same file in the same turn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orin-rw-"));
    const filePath = join(dir, "data.txt");
    await writeFile(filePath, "stale\n", "utf8");

    const slowWrite: Tool<{ path: string; content: string }> = {
      name: "write",
      description: "slow write",
      schema: z.object({ path: z.string(), content: z.string() }),
      async execute({ path, content }, ctx) {
        // Delay so a parallel read would observe stale data without serialization.
        await new Promise((r) => setTimeout(r, 30));
        await writeFile(join(ctx.cwd, path), content, "utf8");
        return { output: "written" };
      },
    };

    const read: Tool<{ path: string }> = {
      name: "read",
      description: "read",
      schema: z.object({ path: z.string() }),
      async execute({ path }, ctx) {
        return { output: await readFile(join(ctx.cwd, path), "utf8") };
      },
    };

    const provider = createStatefulFauxProvider([
      {
        toolCalls: [
          { id: "tc1", name: "write", arguments: { path: "data.txt", content: "fresh\n" } },
          { id: "tc2", name: "read", arguments: { path: "data.txt" } },
        ],
      },
      { text: ["done"] },
    ]);

    const ctx: AgentContext = {
      cwd: dir,
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      workspace: createLocalWorkspace(),
    };

    const result = await runLoop(ctx, hooks([slowWrite, read]), {
      provider,
      tools: [slowWrite, read],
      model: "faux:test",
    });

    const readResult = result.messages.find(
      (m) => m.role === "tool" && m.content.some((c) => c.type === "toolResult" && c.toolCallId === "tc2"),
    );
    const output = readResult?.content.find((c) => c.type === "toolResult")?.output ?? "";
    expect(output).toBe("fresh\n");
    await rm(dir, { recursive: true, force: true });
  });

  it("serializes grep and write on the same file in one turn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orin-grep-write-"));
    const filePath = join(dir, "data.txt");
    await writeFile(filePath, "needle\n", "utf8");

    const slowWrite: Tool<{ path: string; content: string }> = {
      name: "write",
      description: "slow write",
      schema: z.object({ path: z.string(), content: z.string() }),
      async execute({ path, content }, ctx) {
        await new Promise((r) => setTimeout(r, 30));
        await writeFile(join(ctx.cwd, path), content, "utf8");
        return { output: "written" };
      },
    };

    const grep: Tool<{ pattern: string; path?: string }> = {
      name: "grep",
      description: "grep file",
      schema: z.object({ pattern: z.string(), path: z.string().optional() }),
      async execute({ pattern, path }, ctx) {
        const fullPath = join(ctx.cwd, path ?? ".");
        const content = await readFile(fullPath, "utf8");
        const matches = content
          .split("\n")
          .filter((line) => line.includes(pattern))
          .join("\n");
        return { output: matches || "(no matches)" };
      },
    };

    const provider = createStatefulFauxProvider([
      {
        toolCalls: [
          { id: "tc1", name: "write", arguments: { path: "data.txt", content: "updated\n" } },
          { id: "tc2", name: "grep", arguments: { pattern: "updated", path: "data.txt" } },
        ],
      },
      { text: ["done"] },
    ]);

    const ctx: AgentContext = {
      cwd: dir,
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      workspace: createLocalWorkspace(),
    };

    const result = await runLoop(ctx, hooks([slowWrite, grep]), {
      provider,
      tools: [slowWrite, grep],
      model: "faux:test",
    });

    const grepResult = result.messages.find(
      (m) => m.role === "tool" && m.content.some((c) => c.type === "toolResult" && c.toolCallId === "tc2"),
    );
    const output = grepResult?.content.find((c) => c.type === "toolResult")?.output ?? "";
    expect(output).toBe("updated");
    await rm(dir, { recursive: true, force: true });
  });

  it("serializes bash redirection and write on the same file in one turn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orin-bash-write-"));
    const filePath = join(dir, "out.txt");
    await writeFile(filePath, "stale\n", "utf8");

    const bash: Tool<{ command: string }> = {
      name: "bash",
      description: "slow bash write",
      schema: z.object({ command: z.string() }),
      async execute({ command }, ctx) {
        const match = command.match(/>\s*(\S+)/);
        const target = match?.[1];
        if (!target) return { output: "no target" };
        await new Promise((r) => setTimeout(r, 30));
        await writeFile(join(ctx.cwd, target), "from-bash\n", "utf8");
        return { output: "done" };
      },
    };

    const read: Tool<{ path: string }> = {
      name: "read",
      description: "read",
      schema: z.object({ path: z.string() }),
      async execute({ path }, ctx) {
        return { output: await readFile(join(ctx.cwd, path), "utf8") };
      },
    };

    const provider = createStatefulFauxProvider([
      {
        toolCalls: [
          { id: "tc1", name: "bash", arguments: { command: "echo fresh > out.txt" } },
          { id: "tc2", name: "read", arguments: { path: "out.txt" } },
        ],
      },
      { text: ["done"] },
    ]);

    const ctx: AgentContext = {
      cwd: dir,
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      workspace: createLocalWorkspace(),
    };

    const result = await runLoop(ctx, hooks([bash, read]), {
      provider,
      tools: [bash, read],
      model: "faux:test",
    });

    const readResult = result.messages.find(
      (m) => m.role === "tool" && m.content.some((c) => c.type === "toolResult" && c.toolCallId === "tc2"),
    );
    const output = readResult?.content.find((c) => c.type === "toolResult")?.output ?? "";
    expect(output).toBe("from-bash\n");
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

  it("re-prompts when structured tool args are invalid", async () => {
    let providerCalls = 0;
    const baseProvider = createStatefulFauxProvider([
      {
        toolCalls: [{ id: "tc1", name: "read", arguments: { wrong: "package.json" } }],
      },
      {
        toolCalls: [{ id: "tc2", name: "read", arguments: { path: "package.json" } }],
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
    expect(ctx.messages.some((m) => m.role === "tool")).toBe(true);
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

  it("forwards tool_input_start/tool_input_delta progress events to hooks", async () => {
    const dummyTool: Tool<{ path: string }> = {
      name: "write",
      description: "write a file",
      schema: z.object({ path: z.string() }),
      async execute() {
        return { output: "ok" };
      },
    };

    let calls = 0;
    const provider: StreamAssistantFn = async (_messages, options, emit) => {
      calls += 1;
      if (calls === 1) {
        emit({ type: "tool_input_start", id: "tc1", name: "write" });
        emit({ type: "tool_input_delta", id: "tc1", name: "write", chars: 12 });
        emit({ type: "tool_input_delta", id: "tc1", name: "write", chars: 30 });
        return {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc1", name: "write", arguments: { path: "a.txt" } }],
          model: options.model,
        };
      }
      return { role: "assistant", content: [{ type: "text", text: "done" }], model: options.model };
    };

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "write a file" }] }],
      workspace: createLocalWorkspace(),
    };

    const registry = hooks([dummyTool]);
    const observed: AgentEvent[] = [];
    registry.observe((e) => observed.push(e));

    await runLoop(ctx, registry, { provider, tools: [dummyTool], model: "faux:test" });

    const progressEvents = observed.filter(
      (e) => e.type === "tool_input_start" || e.type === "tool_input_delta",
    );
    expect(progressEvents).toEqual([
      { type: "tool_input_start", id: "tc1", name: "write" },
      { type: "tool_input_delta", id: "tc1", name: "write", chars: 12 },
      { type: "tool_input_delta", id: "tc1", name: "write", chars: 30 },
    ]);
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

  it("terminates the loop on a critical system error instead of retrying", async () => {
    let calls = 0;
    const diskFullTool: Tool<{ path: string }> = {
      name: "write",
      description: "write a file",
      schema: z.object({ path: z.string() }),
      async execute() {
        calls += 1;
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      },
    };

    // Provider would keep issuing the same failing call if the loop did not stop.
    const provider = createStatefulFauxProvider([
      { toolCalls: [{ id: "tc1", name: "write", arguments: { path: "a.txt" } }] },
      { toolCalls: [{ id: "tc2", name: "write", arguments: { path: "a.txt" } }] },
      { text: ["done"] },
    ]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "write" }] }],
      workspace: createLocalWorkspace(),
    };

    const registry = hooks([diskFullTool]);
    const observed: AgentEvent[] = [];
    registry.observe((e) => observed.push(e));

    await runLoop(ctx, registry, { provider, tools: [diskFullTool], model: "faux:test" });

    // The failing tool ran exactly once — the loop did not retry it.
    expect(calls).toBe(1);
    expect(observed.some((e) => e.type === "loop_end" && e.reason === "error")).toBe(true);
    const toolMsg = ctx.messages.find((m) => m.role === "tool");
    const output = toolMsg?.content[0]?.type === "toolResult" ? toolMsg.content[0].output : "";
    expect(output).toContain("Critical system error");
  });

  it("returns recoverable tool errors to the model without terminating", async () => {
    let calls = 0;
    const flakyTool: Tool<{ path: string }> = {
      name: "read",
      description: "read a file",
      schema: z.object({ path: z.string() }),
      async execute() {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        }
        return { output: "ok" };
      },
    };

    const provider = createStatefulFauxProvider([
      { toolCalls: [{ id: "tc1", name: "read", arguments: { path: "a.txt" } }] },
      { toolCalls: [{ id: "tc2", name: "read", arguments: { path: "b.txt" } }] },
      { text: ["done"] },
    ]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "read" }] }],
      workspace: createLocalWorkspace(),
    };

    const registry = hooks([flakyTool]);
    const observed: AgentEvent[] = [];
    registry.observe((e) => observed.push(e));

    await runLoop(ctx, registry, { provider, tools: [flakyTool], model: "faux:test" });

    // Loop continued past the recoverable error and completed normally.
    expect(calls).toBe(2);
    expect(observed.some((e) => e.type === "loop_end" && e.reason === "complete")).toBe(true);
    expect(lastAssistantText(ctx)).toBe("done");
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

  it("stops at maxTurns even when the model keeps calling tools", async () => {
    let executions = 0;
    const noopTool: Tool<Record<string, never>> = {
      name: "noop",
      description: "noop",
      schema: z.object({}),
      async execute() {
        executions += 1;
        return { output: "ok" };
      },
    };

    // A single repeating script always asks for another tool call, so the loop
    // would never complete on its own — only maxTurns can stop it.
    const provider = createStatefulFauxProvider([
      { toolCalls: [{ id: "tc", name: "noop", arguments: {} }] },
    ]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      workspace: createLocalWorkspace(),
    };

    const registry = hooks([noopTool]);
    const observed: AgentEvent[] = [];
    registry.observe((e) => observed.push(e));

    await runLoop(ctx, registry, {
      provider,
      tools: [noopTool],
      model: "faux:test",
      maxTurns: 2,
    });

    const assistantMessages = ctx.messages.filter((m) => m.role === "assistant");
    expect(assistantMessages).toHaveLength(3);
    expect(executions).toBe(2);
    expect(lastAssistantText(ctx)).toContain("assistant round");
    expect(observed.some((e) => e.type === "loop_end" && e.reason === "terminate")).toBe(true);
  });

  it("stops at maxToolCalls even when the model keeps calling tools", async () => {
    let executions = 0;
    const noopTool: Tool<Record<string, never>> = {
      name: "noop",
      description: "noop",
      schema: z.object({}),
      async execute() {
        executions += 1;
        return { output: "ok" };
      },
    };

    // Two tool calls per turn; maxToolCalls=3 means the loop stops after turn 2
    // (3 total calls executed before the check fires on the second batch of 2).
    const provider = createStatefulFauxProvider([
      {
        toolCalls: [
          { id: "tc1", name: "noop", arguments: {} },
          { id: "tc2", name: "noop", arguments: {} },
        ],
      },
    ]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      workspace: createLocalWorkspace(),
    };

    const registry = hooks([noopTool]);
    const observed: AgentEvent[] = [];
    registry.observe((e) => observed.push(e));

    await runLoop(ctx, registry, {
      provider,
      tools: [noopTool],
      model: "faux:test",
      maxToolCalls: 3,
    });

    // The loop executes the first batch of 2 tool calls (totalToolCalls=2 < 3),
    // then the second batch of 2 (totalToolCalls=4 >= 3) triggers the cap.
    expect(executions).toBe(4);
    expect(lastAssistantText(ctx)).toContain("tool call");
    expect(observed.some((e) => e.type === "loop_end" && e.reason === "terminate")).toBe(true);
  });

  it("exits immediately when a tool returns terminate: true", async () => {
    const terminatingTool: Tool<Record<string, never>> = {
      name: "finish",
      description: "ends the loop",
      schema: z.object({}),
      async execute() {
        return { output: "stopping", terminate: true };
      },
    };

    // Second script would emit final text — it must never run because the
    // terminating tool short-circuits the loop.
    const provider = createStatefulFauxProvider([
      { toolCalls: [{ id: "tc1", name: "finish", arguments: {} }] },
      { text: ["this should never be reached"] },
    ]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      workspace: createLocalWorkspace(),
    };

    const registry = hooks([terminatingTool]);
    const observed: AgentEvent[] = [];
    registry.observe((e) => observed.push(e));

    await runLoop(ctx, registry, {
      provider,
      tools: [terminatingTool],
      model: "faux:test",
    });

    expect(observed.some((e) => e.type === "loop_end" && e.reason === "terminate")).toBe(true);
    // Only the tool-call turn ran; the follow-up text turn was skipped.
    expect(ctx.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(lastAssistantText(ctx)).not.toContain("never be reached");
    const toolMsg = ctx.messages.find((m) => m.role === "tool");
    const output = toolMsg?.content[0]?.type === "toolResult" ? toolMsg.content[0].output : "";
    expect(output).toBe("stopping");
  });
});

describe("runLoop compaction guards", () => {
  function hooks(tools: AnyTool[] = []) {
    const registry = createHookRegistry();
    installCoreHooks(registry, {
      mode: "auto-accept",
      autoAcceptCli: true,
      tools,
    });
    return registry;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const readTools = getCoreTools().filter((t) => t.name === "read");

  it("does not call the provider when compaction is cancelled mid-flight (#387)", async () => {
    vi.spyOn(compaction, "shouldCompact").mockReturnValue(true);
    const controller = new AbortController();
    vi.spyOn(compaction, "compactMessages").mockImplementation(async (messages) => {
      controller.abort();
      return messages;
    });

    const provider: StreamAssistantFn = async () => {
      throw new Error("provider should not have been called");
    };

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      workspace: createLocalWorkspace(),
    };

    const registry = hooks(readTools);
    const observed: AgentEvent[] = [];
    registry.observe((e) => observed.push(e));

    await runLoop(ctx, registry, {
      provider,
      tools: readTools,
      model: "faux:test",
      signal: controller.signal,
    });

    expect(observed.some((e) => e.type === "loop_end" && e.reason === "cancelled")).toBe(true);
    expect(observed.filter((e) => e.type === "llm_start")).toHaveLength(0);
  });

  it("ends with a user-visible hint when compaction cannot shrink the context (#372)", async () => {
    vi.spyOn(compaction, "shouldCompact").mockReturnValue(true);
    vi.spyOn(compaction, "compactMessages").mockImplementation(async (messages) => messages);

    const provider: StreamAssistantFn = async () => {
      throw new Error("provider should not have been called");
    };

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      workspace: createLocalWorkspace(),
    };

    const registry = hooks(readTools);
    const observed: AgentEvent[] = [];
    registry.observe((e) => observed.push(e));

    await runLoop(ctx, registry, {
      provider,
      tools: readTools,
      model: "faux:test",
    });

    expect(observed.some((e) => e.type === "loop_end" && e.reason === "error")).toBe(true);
    expect(observed.filter((e) => e.type === "llm_start")).toHaveLength(0);
    expect(lastAssistantText(ctx)).toContain("context is full");
  });

  it("calls the provider when compaction brings the context under the limit", async () => {
    vi.spyOn(compaction, "shouldCompact")
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    vi.spyOn(compaction, "compactMessages").mockImplementation(async (messages) => [
      messages[0]!,
    ]);

    const provider = createStatefulFauxProvider([{ text: ["compacted ok"] }]);

    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "text", text: "old history" }] },
      ],
      workspace: createLocalWorkspace(),
    };

    const registry = hooks(readTools);
    const observed: AgentEvent[] = [];
    registry.observe((e) => observed.push(e));

    await runLoop(ctx, registry, {
      provider,
      tools: readTools,
      model: "faux:test",
    });

    expect(observed.filter((e) => e.type === "llm_start")).toHaveLength(1);
    expect(lastAssistantText(ctx)).toBe("compacted ok");
  });

  it("triggers compaction when before_prompt injections exceed the budget (#371)", async () => {
    vi.spyOn(contextWindow, "getContextWindow").mockResolvedValue(1000);
    const compactSpy = vi.spyOn(compaction, "compactMessages").mockImplementation(async (messages) => [
      messages[0]!,
    ]);

    const provider = createStatefulFauxProvider([{ text: ["ok"] }]);
    const ctx: AgentContext = {
      cwd: process.cwd(),
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      workspace: createLocalWorkspace(),
    };

    const registry = hooks();
    registry.on("before_prompt", ({ messages }) => ({
      messages: [
        { role: "user", content: [{ type: "text", text: "x".repeat(4000) }] },
        ...messages,
      ],
    }));

    await runLoop(ctx, registry, {
      provider,
      tools: [],
      model: "faux:test",
    });

    expect(compactSpy).toHaveBeenCalled();
    const overhead = compactSpy.mock.calls[0]?.[7];
    expect(overhead?.injectionTokens).toBeGreaterThan(500);
  });
});
