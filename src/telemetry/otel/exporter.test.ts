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

  it("starts orphan spans on ROOT_CONTEXT when no turn root is open", async () => {
    const { exporter, consumer } = harness();
    consumer.handleEvent({ type: "llm_start", id: "c1", model: "faux:test" });
    consumer.handleEvent({ type: "assistant_message", id: "c1", message: assistantMessage() });
    await consumer.flush();

    const llm = byName(exporter.getFinishedSpans(), "chat faux:test")!;
    expect(llm.parentSpanContext).toBeUndefined();
  });
});

describe("resolveOtelUserId", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-otel-user-"));
    process.env.HOME = home;
    delete process.env.OTEL_USER_ID;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    delete process.env.OTEL_USER_ID;
    rmSync(home, { recursive: true, force: true });
  });

  it("prefers OTEL_USER_ID env over config", async () => {
    process.env.OTEL_USER_ID = "env-user";
    const { resolveOtelUserId } = await import("./config.js");
    expect(resolveOtelUserId(enabledCfg)).toBe("env-user");
  });

  it("reads userId from config when env is absent", async () => {
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
