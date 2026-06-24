import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import { SpanStatusCode } from "@opentelemetry/api";
import { z } from "zod";
import type { ModelPricing } from "../../config/config.js";
import type { AssistantMessage } from "../../provider/types.js";
import { createOtelSpanConsumer, type OtelConsumerOptions } from "./exporter.js";
import type { OtelConfig } from "./config.js";

const enabledCfg: OtelConfig = {
  enabled: true,
  endpoint: "",
  protocol: "http/protobuf",
  headers: {},
  serviceName: "orin",
  semconv: "genai",
  captureContent: false,
  sampleRatio: 1,
};

const pricing: Record<string, ModelPricing> = {
  "faux:test": { inputPerM: 1, outputPerM: 2 },
};

function harness(overrides: Partial<OtelConsumerOptions> = {}) {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const consumer = createOtelSpanConsumer({
    sessionId: "s1",
    providerId: "faux",
    pricing,
    cfg: enabledCfg,
    userId: "user-abc",
    deps: { tracerProvider: provider },
    ...overrides,
  });
  if (!consumer) throw new Error("expected a consumer for enabled config");
  return { exporter, provider, consumer };
}

function assistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    model: "faux:test",
    usage: { input: 100, output: 50, cacheRead: 10, totalTokens: 160 },
    stopReason: "stop",
  };
}

const byName = (spans: ReadableSpan[], name: string) => spans.find((s) => s.name === name);

function runTurn(
  consumer: ReturnType<typeof harness>["consumer"],
  opts: { turnId?: string; endReason?: "complete" | "terminate" | "error" } = {},
) {
  const turnId = opts.turnId ?? "turn-1";
  consumer.handleEvent({ type: "turn_start", id: turnId });
  consumer.handleEvent({ type: "llm_start", id: "c1", model: "faux:test" });
  consumer.handleEvent({ type: "assistant_message", id: "c1", message: assistantMessage() });
  consumer.handleEvent({ type: "tool_start", id: "t1", name: "read", args: {} });
  consumer.handleEvent({ type: "tool_end", id: "t1", name: "read", output: "data" });
  consumer.handleEvent({ type: "loop_end", reason: opts.endReason ?? "complete" });
}

describe("createOtelSpanConsumer", () => {
  it("returns undefined when OTLP export is disabled", () => {
    const consumer = createOtelSpanConsumer({
      sessionId: "s1",
      pricing,
      cfg: { ...enabledCfg, enabled: false },
    });
    expect(consumer).toBeUndefined();
  });

  it("exports a per-turn trace root with paired LLM and tool spans", async () => {
    const { exporter, consumer } = harness();

    runTurn(consumer);
    await consumer.flush();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(3);

    const root = byName(spans, "turn")!;
    const llm = byName(spans, "chat faux:test")!;
    const tool = byName(spans, "read")!;
    expect(root && llm && tool).toBeTruthy();

    expect(root.attributes["session.id"]).toBe("s1");
    expect(root.attributes["langfuse.session.id"]).toBe("s1");
    expect(root.attributes["user.id"]).toBe("user-abc");
    expect(root.attributes["langfuse.user.id"]).toBe("user-abc");

    // LLM generation span — gen_ai request + response attributes.
    expect(llm.attributes["gen_ai.operation.name"]).toBe("chat");
    expect(llm.attributes["gen_ai.provider.name"]).toBe("faux");
    expect(llm.attributes["gen_ai.request.model"]).toBe("faux:test");
    expect(llm.attributes["gen_ai.response.model"]).toBe("faux:test");
    expect(llm.attributes["gen_ai.usage.input_tokens"]).toBe(100);
    expect(llm.attributes["gen_ai.usage.output_tokens"]).toBe(50);
    expect(llm.attributes["gen_ai.usage.cache_read_tokens"]).toBe(10);
    expect(llm.attributes["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
    // cost = 100/1e6*1 + 50/1e6*2 + 10/1e6*1 (cacheRead falls back to input rate)
    expect(llm.attributes["gen_ai.usage.cost_usd"]).toBeCloseTo(0.00021, 9);
    expect(llm.attributes["pricing.missing"]).toBe(false);

    // Tool span.
    expect(tool.attributes["gen_ai.operation.name"]).toBe("execute_tool");
    expect(tool.attributes["gen_ai.tool.name"]).toBe("read");
    expect(tool.attributes["gen_ai.tool.call.id"]).toBe("t1");
    expect(tool.attributes["orin.tool.ok"]).toBe(true);
    expect(tool.attributes["orin.tool.output_bytes"]).toBe(4);
    expect(tool.status.code).toBe(SpanStatusCode.UNSET);

    // Both children parent on the turn root, in one trace.
    const rootId = root.spanContext().spanId;
    expect(llm.parentSpanContext?.spanId).toBe(rootId);
    expect(tool.parentSpanContext?.spanId).toBe(rootId);
    expect(llm.spanContext().traceId).toBe(root.spanContext().traceId);
  });

  it("assigns one distinct traceId per turn_start→loop_end", async () => {
    const { exporter, consumer } = harness();

    runTurn(consumer, { turnId: "a" });
    runTurn(consumer, { turnId: "b" });
    await consumer.flush();

    const roots = exporter.getFinishedSpans().filter((s) => s.name === "turn");
    expect(roots).toHaveLength(2);
    expect(roots[0].spanContext().traceId).not.toBe(roots[1].spanContext().traceId);
  });

  it("keeps the same session.id across turns in one Orin session", async () => {
    const { exporter, consumer } = harness();

    runTurn(consumer, { turnId: "a" });
    runTurn(consumer, { turnId: "b" });
    await consumer.flush();

    const roots = exporter.getFinishedSpans().filter((s) => s.name === "turn");
    expect(roots.every((r) => r.attributes["session.id"] === "s1")).toBe(true);
    expect(roots.every((r) => r.attributes["langfuse.session.id"] === "s1")).toBe(true);
  });

  it("uses a new session.id after a simulated /new (new consumer)", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const deps = { tracerProvider: provider };

    const first = createOtelSpanConsumer({
      sessionId: "s1",
      pricing,
      cfg: enabledCfg,
      userId: "u1",
      deps,
    })!;
    runTurn(first, { turnId: "t1" });
    await first.flush();

    const second = createOtelSpanConsumer({
      sessionId: "s2",
      pricing,
      cfg: enabledCfg,
      userId: "u1",
      deps,
    })!;
    runTurn(second, { turnId: "t2" });
    await second.flush();

    const roots = exporter.getFinishedSpans().filter((s) => s.name === "turn");
    expect(roots.map((r) => r.attributes["session.id"]).sort()).toEqual(["s1", "s2"]);
  });

  it("omits user.id when not resolved", async () => {
    const { exporter, consumer } = harness({ userId: "" });
    runTurn(consumer);
    await consumer.flush();

    const root = byName(exporter.getFinishedSpans(), "turn")!;
    expect(root.attributes["user.id"]).toBeUndefined();
    expect(root.attributes["langfuse.user.id"]).toBeUndefined();
  });

  it("marks tool spans ERROR on failure", async () => {
    const { exporter, consumer } = harness();
    consumer.handleEvent({ type: "turn_start", id: "t1" });
    consumer.handleEvent({ type: "tool_start", id: "t1", name: "bash", args: {} });
    consumer.handleEvent({ type: "tool_end", id: "t1", name: "bash", output: "boom", isError: true });
    consumer.handleEvent({ type: "loop_end", reason: "complete" });
    await consumer.flush();

    const tool = byName(exporter.getFinishedSpans(), "bash")!;
    expect(tool.attributes["orin.tool.ok"]).toBe(false);
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("pairs parallel tool spans by call id without collision", async () => {
    const { exporter, consumer } = harness();
    consumer.handleEvent({ type: "turn_start", id: "t1" });
    // Interleaved start/end, ending in reverse order.
    consumer.handleEvent({ type: "tool_start", id: "a", name: "read", args: {} });
    consumer.handleEvent({ type: "tool_start", id: "b", name: "bash", args: {} });
    consumer.handleEvent({ type: "tool_end", id: "b", name: "bash", output: "x" });
    consumer.handleEvent({ type: "tool_end", id: "a", name: "read", output: "yy" });
    consumer.handleEvent({ type: "loop_end", reason: "complete" });
    await consumer.flush();

    const spans = exporter.getFinishedSpans();
    const read = byName(spans, "read")!;
    const bash = byName(spans, "bash")!;
    expect(read.attributes["gen_ai.tool.call.id"]).toBe("a");
    expect(read.attributes["orin.tool.output_bytes"]).toBe(2);
    expect(bash.attributes["gen_ai.tool.call.id"]).toBe("b");
    expect(bash.attributes["orin.tool.output_bytes"]).toBe(1);
  });

  it("closes spans still open at loop_end", async () => {
    const { exporter, consumer } = harness();
    consumer.handleEvent({ type: "turn_start", id: "t1" });
    consumer.handleEvent({ type: "llm_start", id: "c1", model: "faux:test" });
    consumer.handleEvent({ type: "tool_start", id: "t1", name: "read", args: {} });
    // No assistant_message / tool_end — interrupted turn.
    consumer.handleEvent({ type: "loop_end", reason: "error" });
    await consumer.flush();

    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name).sort()).toEqual(["chat faux:test", "read", "turn"]);
    expect(byName(spans, "turn")!.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("records pricing.missing and omits cost for an unknown model", async () => {
    const { exporter, consumer } = harness();
    consumer.handleEvent({ type: "turn_start", id: "t1" });
    consumer.handleEvent({ type: "llm_start", id: "c1", model: "mystery/model" });
    consumer.handleEvent({
      type: "assistant_message",
      id: "c1",
      message: {
        role: "assistant",
        content: [],
        model: "mystery/model",
        usage: { input: 5, output: 5, totalTokens: 10 },
      },
    });
    consumer.handleEvent({ type: "loop_end", reason: "complete" });
    await consumer.flush();

    const llm = byName(exporter.getFinishedSpans(), "chat mystery/model")!;
    expect(llm.attributes["pricing.missing"]).toBe(true);
    expect(llm.attributes["gen_ai.usage.cost_usd"]).toBeUndefined();
  });

  it("nests a subagent's LLM and tool spans under the task tool span", async () => {
    const { exporter, consumer } = harness();

    consumer.handleEvent({ type: "turn_start", id: "turn-1" });
    // Top-level task tool call, then the subagent it spawns.
    consumer.handleEvent({ type: "tool_start", id: "task-call", name: "task", args: {} });
    consumer.handleEvent({
      type: "subagent_start",
      id: "sub1",
      description: "scan repo",
      agent: "explore",
      isolation: "shared",
      model: "faux:test",
    });
    // Child LLM + tool spans forwarded from the subagent, tagged with subagentId.
    consumer.handleEvent({ type: "llm_start", id: "c1", model: "faux:test", subagentId: "sub1" });
    consumer.handleEvent({
      type: "assistant_message",
      id: "c1",
      message: assistantMessage(),
      subagentId: "sub1",
    });
    consumer.handleEvent({ type: "tool_start", id: "ct1", name: "read", args: {}, subagentId: "sub1" });
    consumer.handleEvent({ type: "tool_end", id: "ct1", name: "read", output: "data", subagentId: "sub1" });
    consumer.handleEvent({ type: "subagent_end", id: "sub1", agent: "explore", turns: 3, summary: "done" });
    consumer.handleEvent({ type: "tool_end", id: "task-call", name: "task", output: "done" });
    consumer.handleEvent({ type: "loop_end", reason: "complete" });
    await consumer.flush();

    const spans = exporter.getFinishedSpans();
    const root = byName(spans, "turn")!;
    const task = byName(spans, "task")!;
    const subagent = byName(spans, "subagent:explore")!;
    const llm = byName(spans, "chat faux:test")!;
    const tool = byName(spans, "read")!;

    // task → subagent → {llm, tool}, all in one trace.
    expect(task.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(subagent.parentSpanContext?.spanId).toBe(task.spanContext().spanId);
    expect(llm.parentSpanContext?.spanId).toBe(subagent.spanContext().spanId);
    expect(tool.parentSpanContext?.spanId).toBe(subagent.spanContext().spanId);
    expect(subagent.spanContext().traceId).toBe(root.spanContext().traceId);

    // Subagent span attributes.
    expect(subagent.attributes["gen_ai.operation.name"]).toBe("invoke_agent");
    expect(subagent.attributes["gen_ai.agent.name"]).toBe("explore");
    expect(subagent.attributes["orin.subagent.isolation"]).toBe("shared");
    expect(subagent.attributes["gen_ai.request.model"]).toBe("faux:test");
    expect(subagent.attributes["orin.subagent.turns"]).toBe(3);
  });

  it("keeps concurrent subagents from cross-attributing child spans", async () => {
    const { exporter, consumer } = harness();

    consumer.handleEvent({ type: "turn_start", id: "turn-1" });
    // Two task tool calls fan out, each spawning a subagent (interleaved starts).
    consumer.handleEvent({ type: "tool_start", id: "task-a", name: "task", args: {} });
    consumer.handleEvent({
      type: "subagent_start",
      id: "subA",
      description: "a",
      agent: "explore",
      isolation: "shared",
    });
    consumer.handleEvent({ type: "tool_start", id: "task-b", name: "task", args: {} });
    consumer.handleEvent({
      type: "subagent_start",
      id: "subB",
      description: "b",
      agent: "review",
      isolation: "sandbox",
    });
    // Child tools arrive interleaved, each tagged with its own subagentId.
    consumer.handleEvent({ type: "tool_start", id: "ta", name: "read", args: {}, subagentId: "subA" });
    consumer.handleEvent({ type: "tool_start", id: "tb", name: "bash", args: {}, subagentId: "subB" });
    consumer.handleEvent({ type: "tool_end", id: "tb", name: "bash", output: "x", subagentId: "subB" });
    consumer.handleEvent({ type: "tool_end", id: "ta", name: "read", output: "y", subagentId: "subA" });
    consumer.handleEvent({ type: "subagent_end", id: "subB", agent: "review", turns: 1, summary: "b" });
    consumer.handleEvent({ type: "subagent_end", id: "subA", agent: "explore", turns: 2, summary: "a" });
    consumer.handleEvent({ type: "tool_end", id: "task-a", name: "task", output: "a" });
    consumer.handleEvent({ type: "tool_end", id: "task-b", name: "task", output: "b" });
    consumer.handleEvent({ type: "loop_end", reason: "complete" });
    await consumer.flush();

    const spans = exporter.getFinishedSpans();
    const subA = byName(spans, "subagent:explore")!;
    const subB = byName(spans, "subagent:review")!;
    const taskA = spans.find((s) => s.attributes["gen_ai.tool.call.id"] === "task-a")!;
    const taskB = spans.find((s) => s.attributes["gen_ai.tool.call.id"] === "task-b")!;
    const read = byName(spans, "read")!;
    const bash = byName(spans, "bash")!;

    // Each subagent nests under its own task span — no cross-attribution.
    expect(subA.parentSpanContext?.spanId).toBe(taskA.spanContext().spanId);
    expect(subB.parentSpanContext?.spanId).toBe(taskB.spanContext().spanId);
    // Sibling isolation: each child tool parents on its own subagent.
    expect(read.parentSpanContext?.spanId).toBe(subA.spanContext().spanId);
    expect(bash.parentSpanContext?.spanId).toBe(subB.spanContext().spanId);
  });

  it("falls back to the turn root for subagent child spans when subagentId is unknown", async () => {
    const { exporter, consumer } = harness();

    consumer.handleEvent({ type: "turn_start", id: "turn-1" });
    // No matching subagent span open — parent should be the turn root.
    consumer.handleEvent({ type: "tool_start", id: "ct1", name: "read", args: {}, subagentId: "ghost" });
    consumer.handleEvent({ type: "tool_end", id: "ct1", name: "read", output: "data", subagentId: "ghost" });
    consumer.handleEvent({ type: "loop_end", reason: "complete" });
    await consumer.flush();

    const spans = exporter.getFinishedSpans();
    const root = byName(spans, "turn")!;
    const tool = byName(spans, "read")!;
    expect(tool.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
  });

  it("starts orphan spans on ROOT_CONTEXT when no turn root is open", async () => {
    const { exporter, consumer } = harness();
    consumer.handleEvent({ type: "llm_start", id: "c1", model: "faux:test" });
    consumer.handleEvent({ type: "assistant_message", id: "c1", message: assistantMessage() });
    await consumer.flush();

    const llm = byName(exporter.getFinishedSpans(), "chat faux:test")!;
    expect(llm.parentSpanContext).toBeUndefined();
  });

  it("names the trace root from the turn's first user message", async () => {
    const { exporter, consumer } = harness();
    consumer.handleEvent({ type: "turn_start", id: "t1", firstUserText: "  refactor the\n loop  " });
    consumer.handleEvent({ type: "loop_end", reason: "complete" });
    await consumer.flush();

    const root = exporter.getFinishedSpans().find((s) => s.attributes["orin.turn.id"] === "t1")!;
    expect(root.name).toBe("refactor the loop");
    expect(root.attributes["orin.turn.id"]).toBe("t1");
  });

  it("falls back to `turn` as the trace name when no user text is present", async () => {
    const { exporter, consumer } = harness();
    runTurn(consumer);
    await consumer.flush();
    expect(byName(exporter.getFinishedSpans(), "turn")).toBeTruthy();
  });

  it("sets openinference.span.kind on every span (content-free)", async () => {
    const { exporter, consumer } = harness();
    consumer.handleEvent({ type: "turn_start", id: "turn-1" });
    consumer.handleEvent({ type: "tool_start", id: "task-call", name: "task", args: {} });
    consumer.handleEvent({ type: "subagent_start", id: "sub1", description: "d", agent: "explore" });
    consumer.handleEvent({ type: "llm_start", id: "c1", model: "faux:test", subagentId: "sub1" });
    consumer.handleEvent({ type: "assistant_message", id: "c1", message: assistantMessage(), subagentId: "sub1" });
    consumer.handleEvent({ type: "subagent_end", id: "sub1", agent: "explore", turns: 1, summary: "s" });
    consumer.handleEvent({ type: "tool_end", id: "task-call", name: "task", output: "ok" });
    consumer.handleEvent({ type: "loop_end", reason: "complete" });
    await consumer.flush();

    const spans = exporter.getFinishedSpans();
    expect(byName(spans, "turn")!.attributes["openinference.span.kind"]).toBe("AGENT");
    expect(byName(spans, "chat faux:test")!.attributes["openinference.span.kind"]).toBe("LLM");
    expect(byName(spans, "task")!.attributes["openinference.span.kind"]).toBe("TOOL");
    expect(byName(spans, "subagent:explore")!.attributes["openinference.span.kind"]).toBe("AGENT");
  });

  it("emits no content attributes when captureContent is off (default)", async () => {
    const { exporter, consumer } = harness();
    consumer.handleEvent({
      type: "turn_start",
      id: "t1",
      firstUserText: "secret prompt",
    });
    consumer.handleEvent({
      type: "llm_start",
      id: "c1",
      model: "faux:test",
      request: { system: "sys", messages: [{ role: "user", content: [{ type: "text", text: "secret" }] }] },
    });
    consumer.handleEvent({ type: "assistant_message", id: "c1", message: assistantMessage() });
    consumer.handleEvent({ type: "tool_start", id: "t1", name: "read", args: { path: "secret.ts" } });
    consumer.handleEvent({ type: "tool_end", id: "t1", name: "read", output: "secret data" });
    consumer.handleEvent({ type: "loop_end", reason: "complete" });
    await consumer.flush();

    for (const span of exporter.getFinishedSpans()) {
      expect(span.attributes["input.value"]).toBeUndefined();
      expect(span.attributes["output.value"]).toBeUndefined();
      expect(span.attributes["input.mime_type"]).toBeUndefined();
      expect(span.attributes["output.mime_type"]).toBeUndefined();
    }
  });
});

describe("createOtelSpanConsumer with captureContent: true", () => {
  const captureCfg: OtelConfig = { ...enabledCfg, captureContent: true };

  function captureHarness() {
    return harness({ cfg: captureCfg });
  }

  it("captures lossless LLM input (request) and output (assistant tool_calls as JSON)", async () => {
    const { exporter, consumer } = captureHarness();
    consumer.handleEvent({ type: "turn_start", id: "t1", firstUserText: "do it" });
    consumer.handleEvent({
      type: "llm_start",
      id: "c1",
      model: "faux:test",
      request: {
        system: "You are helpful.",
        messages: [{ role: "user", content: [{ type: "text", text: "read a.ts" }] }],
        tools: [{ name: "read", description: "Read a file", schema: z.object({ path: z.string() }) }],
      },
    });
    consumer.handleEvent({
      type: "assistant_message",
      id: "c1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
        ],
        model: "faux:test",
        usage: { input: 1, output: 1, totalTokens: 2 },
        stopReason: "tool_calls",
      },
    });
    consumer.handleEvent({ type: "loop_end", reason: "complete" });
    await consumer.flush();

    const llm = byName(exporter.getFinishedSpans(), "chat faux:test")!;
    expect(llm.attributes["input.mime_type"]).toBe("application/json");
    const input = JSON.parse(llm.attributes["input.value"] as string);
    expect(input.messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(input.messages[1]).toEqual({ role: "user", content: "read a.ts" });
    expect(input.tools[0].json_schema.properties.path).toBeDefined();

    expect(llm.attributes["output.mime_type"]).toBe("application/json");
    const output = JSON.parse(llm.attributes["output.value"] as string);
    expect(output.content).toBe("reading");
    expect(output.finish_reason).toBe("tool_calls");
    expect(output.tool_calls).toEqual([{ id: "tc1", name: "read", arguments: { path: "a.ts" } }]);
  });

  it("captures tool args and result content", async () => {
    const { exporter, consumer } = captureHarness();
    consumer.handleEvent({ type: "turn_start", id: "t1" });
    consumer.handleEvent({ type: "tool_start", id: "tool1", name: "read", args: { path: "a.ts" } });
    consumer.handleEvent({ type: "tool_end", id: "tool1", name: "read", output: "file body" });
    consumer.handleEvent({ type: "loop_end", reason: "complete" });
    await consumer.flush();

    const tool = byName(exporter.getFinishedSpans(), "read")!;
    expect(tool.attributes["input.value"]).toBe('{"path":"a.ts"}');
    expect(tool.attributes["input.mime_type"]).toBe("application/json");
    expect(tool.attributes["output.value"]).toBe("file body");
    expect(tool.attributes["output.mime_type"]).toBe("text/plain");
  });

  it("captures subagent prompt and summary", async () => {
    const { exporter, consumer } = captureHarness();
    consumer.handleEvent({ type: "turn_start", id: "t1" });
    consumer.handleEvent({ type: "tool_start", id: "task-call", name: "task", args: {} });
    consumer.handleEvent({
      type: "subagent_start",
      id: "sub1",
      description: "scan",
      prompt: "scan the whole repo",
      agent: "explore",
    });
    consumer.handleEvent({ type: "subagent_end", id: "sub1", agent: "explore", turns: 2, summary: "found it" });
    consumer.handleEvent({ type: "tool_end", id: "task-call", name: "task", output: "done" });
    consumer.handleEvent({ type: "loop_end", reason: "complete" });
    await consumer.flush();

    const subagent = byName(exporter.getFinishedSpans(), "subagent:explore")!;
    expect(subagent.attributes["input.value"]).toBe("scan the whole repo");
    expect(subagent.attributes["output.value"]).toBe("found it");
  });

  it("snapshots LLM input at emit time, before the live message array mutates", async () => {
    const { exporter, consumer } = captureHarness();
    // The request aliases a live array; the loop pushes to it after llm_start.
    const messages: { role: "user" | "assistant"; content: { type: "text"; text: string }[] }[] = [
      { role: "user", content: [{ type: "text", text: "first" }] },
    ];
    consumer.handleEvent({ type: "turn_start", id: "t1" });
    consumer.handleEvent({ type: "llm_start", id: "c1", model: "faux:test", request: { messages } });
    // Mutate after the event is handled — the captured snapshot must not change.
    messages.push({ role: "assistant", content: [{ type: "text", text: "later" }] });
    consumer.handleEvent({ type: "assistant_message", id: "c1", message: assistantMessage() });
    consumer.handleEvent({ type: "loop_end", reason: "complete" });
    await consumer.flush();

    const input = JSON.parse(byName(exporter.getFinishedSpans(), "chat faux:test")!.attributes["input.value"] as string);
    expect(input.messages).toHaveLength(1);
    expect(input.messages[0].content).toBe("first");
  });
});

describe("resolveOtelUserId", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-otel-user-"));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("reads userId from config", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ telemetry: { otel: { userId: "cfg-user" } } });
    const { resolveOtelUserId } = await import("./config.js");
    expect(resolveOtelUserId(enabledCfg)).toBe("cfg-user");
  });

  it("generates and persists a userId on first OTLP-enabled run", async () => {
    const { resolveOtelUserId } = await import("./config.js");
    const id = resolveOtelUserId(enabledCfg);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const raw = readFileSync(join(home, ".orin", "config.json"), "utf8");
    const parsed = JSON.parse(raw) as { telemetry: { otel: { userId: string } } };
    expect(parsed.telemetry.otel.userId).toBe(id);

    const again = resolveOtelUserId(enabledCfg);
    expect(again).toBe(id);
  });

  it("returns undefined when OTLP export is disabled", async () => {
    const { resolveOtelUserId } = await import("./config.js");
    expect(resolveOtelUserId({ ...enabledCfg, enabled: false })).toBeUndefined();
  });
});
