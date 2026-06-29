import { describe, expect, it } from "vitest";
import type { MetricEvent } from "../telemetry/events.js";
import type { MetricSink } from "../telemetry/sinks.js";
import { createHookRegistry } from "../hooks/registry.js";
import {
  emitRatelPrefilterMetric,
  installRatelTelemetry,
  isRatelGatewayTool,
  normalizeRatelTraceEvent,
  ratelResolutionAttributes,
} from "./telemetry.js";

function collectingSink(): MetricSink & { events: MetricEvent[] } {
  const events: MetricEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
    },
    flush() {},
  };
}

describe("ratel telemetry", () => {
  it("identifies gateway tool names", () => {
    expect(isRatelGatewayTool("search_capabilities")).toBe(true);
    expect(isRatelGatewayTool("invoke_tool")).toBe(true);
    expect(isRatelGatewayTool("read")).toBe(false);
  });

  it("maps pre-filter resolution to ratel-hooks attributes", () => {
    const attrs = ratelResolutionAttributes({
      catalogSize: 22,
      injectedCount: 10,
      query: "grep TODO",
      topK: 5,
      hitCount: 5,
      topHitScore: 1.42,
      replaceMode: true,
      gatewayOrigin: "direct",
      featureFlag: "tool_pool=ratel",
      skillCatalogSize: 2,
      injectedToolNames: ["read", "grep"],
    });
    expect(attrs["ratel.replace_mode"]).toBe(true);
    expect(attrs["feature_flag"]).toBe("tool_pool=ratel");
    expect(attrs["ratel.top_hit_score"]).toBe(1.42);
    expect(attrs["ratel.gateway_origin"]).toBe("direct");
  });

  it("normalizes gateway_search trace envelopes", () => {
    const out = normalizeRatelTraceEvent({
      type: "gateway_search",
      query: "deploy",
      top_k: 5,
      hits: 3,
      took_ms: 2,
    });
    expect(out?.name).toBe("ratel.search_capabilities");
    expect(out?.attributes["ratel.gateway_origin"]).toBe("agent");
    expect(out?.attributes["ratel.hit_count"]).toBe(3);
  });

  it("emits ratel prefilter metrics to sinks", () => {
    const sink = collectingSink();
    emitRatelPrefilterMetric([sink], "sess-1", {
      catalogSize: 10,
      injectedCount: 8,
      query: "read file",
      topK: 5,
      hitCount: 4,
      replaceMode: true,
      gatewayOrigin: "direct",
      featureFlag: "tool_pool=ratel",
      skillCatalogSize: 0,
      injectedToolNames: ["read"],
    });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.type).toBe("ratel");
    if (sink.events[0]?.type === "ratel") {
      expect(sink.events[0].name).toBe("ratel.prefilter");
    }
  });

  it("installRatelTelemetry emits on llm_start and gateway tool_end", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const sink = collectingSink();
    const hooks = createHookRegistry();
    const ratelSnap = {
      catalogSize: 10,
      injectedCount: 8,
      query: "deploy",
      topK: 5,
      hitCount: 4,
      replaceMode: true as const,
      gatewayOrigin: "direct" as const,
      featureFlag: "tool_pool=ratel" as const,
      skillCatalogSize: 0,
      injectedToolNames: ["read"],
    };
    const bundle = {
      drainTraceEvents: () => [
        { type: "gateway_search", query: "deploy", top_k: 5, hits: 2, took_ms: 1 },
      ],
    };
    const dispose = installRatelTelemetry({
      hooks,
      sessionId: "sess-2",
      sinks: [sink],
      getBundle: () => bundle as never,
    });

    hooks.emit({ type: "llm_start", id: "llm-1", model: "test", request: { messages: [], ratel: ratelSnap } });
    await tick();
    expect(sink.events.some((e) => e.type === "ratel" && e.name === "ratel.prefilter")).toBe(true);

    sink.events.length = 0;
    hooks.emit({ type: "tool_end", id: "tc-1", name: "search_capabilities", output: "ok" });
    await tick();
    expect(sink.events.some((e) => e.type === "ratel" && e.name === "ratel.search_capabilities")).toBe(true);

    dispose();
  });
});
