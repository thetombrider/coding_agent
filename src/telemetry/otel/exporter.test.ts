import { describe, expect, it } from "vitest";
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

describe("createOtelSpanConsumer", () => {
  it("returns undefined when OTLP export is disabled", () => {
    const consumer = createOtelSpanConsumer({
      sessionId: "s1",
      pricing,
      cfg: { ...enabledCfg, enabled: false },
    });
    expect(consumer).toBeUndefined();
  });

  it("exports a session root with paired LLM and tool spans", async () => {
    const { exporter, consumer } = harness();

    consumer.startSession();
    consumer.handleEvent({ type: "llm_start", id: "c1", model: "faux:test" });
    consumer.handleEvent({ type: "assistant_message", id: "c1", message: assistantMessage() });
    consumer.handleEvent({ type: "tool_start", id: "t1", name: "read", args: {} });
    consumer.handleEvent({ type: "tool_end", id: "t1", name: "read", output: "data" });
    consumer.endSession("complete");
    await consumer.flush();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(3);

    const root = byName(spans, "session s1")!;
    const llm = byName(spans, "chat faux:test")!;
    const tool = byName(spans, "read")!;
    expect(root && llm && tool).toBeTruthy();

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

    // Both children parent on the session root, in one trace.
    const rootId = root.spanContext().spanId;
    expect(llm.parentSpanContext?.spanId).toBe(rootId);
    expect(tool.parentSpanContext?.spanId).toBe(rootId);
    expect(llm.spanContext().traceId).toBe(root.spanContext().traceId);
  });

  it("marks tool spans ERROR on failure", async () => {
    const { exporter, consumer } = harness();
    consumer.startSession();
    consumer.handleEvent({ type: "tool_start", id: "t1", name: "bash", args: {} });
    consumer.handleEvent({ type: "tool_end", id: "t1", name: "bash", output: "boom", isError: true });
    consumer.endSession("complete");
    await consumer.flush();

    const tool = byName(exporter.getFinishedSpans(), "bash")!;
    expect(tool.attributes["orin.tool.ok"]).toBe(false);
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("pairs parallel tool spans by call id without collision", async () => {
    const { exporter, consumer } = harness();
    consumer.startSession();
    // Interleaved start/end, ending in reverse order.
    consumer.handleEvent({ type: "tool_start", id: "a", name: "read", args: {} });
    consumer.handleEvent({ type: "tool_start", id: "b", name: "bash", args: {} });
    consumer.handleEvent({ type: "tool_end", id: "b", name: "bash", output: "x" });
    consumer.handleEvent({ type: "tool_end", id: "a", name: "read", output: "yy" });
    consumer.endSession("complete");
    await consumer.flush();

    const spans = exporter.getFinishedSpans();
    const read = byName(spans, "read")!;
    const bash = byName(spans, "bash")!;
    expect(read.attributes["gen_ai.tool.call.id"]).toBe("a");
    expect(read.attributes["orin.tool.output_bytes"]).toBe(2);
    expect(bash.attributes["gen_ai.tool.call.id"]).toBe("b");
    expect(bash.attributes["orin.tool.output_bytes"]).toBe(1);
  });

  it("closes spans still open at session end", async () => {
    const { exporter, consumer } = harness();
    consumer.startSession();
    consumer.handleEvent({ type: "llm_start", id: "c1", model: "faux:test" });
    consumer.handleEvent({ type: "tool_start", id: "t1", name: "read", args: {} });
    // No assistant_message / tool_end — interrupted session.
    consumer.endSession("error");
    await consumer.flush();

    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name).sort()).toEqual(["chat faux:test", "read", "session s1"]);
    expect(byName(spans, "session s1")!.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("records pricing.missing and omits cost for an unknown model", async () => {
    const { exporter, consumer } = harness();
    consumer.startSession();
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
    consumer.endSession("complete");
    await consumer.flush();

    const llm = byName(exporter.getFinishedSpans(), "chat mystery/model")!;
    expect(llm.attributes["pricing.missing"]).toBe(true);
    expect(llm.attributes["gen_ai.usage.cost_usd"]).toBeUndefined();
  });
});
