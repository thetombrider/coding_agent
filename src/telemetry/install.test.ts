import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelPricing } from "../config/config.js";
import { createHookRegistry } from "../hooks/registry.js";
import type { AssistantMessage } from "../provider/types.js";
import { testAgentContext } from "../test-helpers.js";
import type { MetricEvent } from "./events.js";
import { SessionCostAccumulator } from "./accumulator.js";
import { createDefaultSinks, installTelemetry, telemetryEnabled } from "./install.js";
import type { MetricSink } from "./sinks.js";

const ctx = testAgentContext("/tmp");
const tick = () => new Promise((r) => setTimeout(r, 0));

const pricing: Record<string, ModelPricing> = {
  "anthropic/claude-opus-4.8": { inputPerM: 15, outputPerM: 75 },
};

function collectingSink(): MetricSink & { events: MetricEvent[]; flushed: number } {
  const events: MetricEvent[] = [];
  return {
    events,
    flushed: 0,
    emit(event) {
      events.push(event);
    },
    flush() {
      this.flushed += 1;
    },
  };
}

function assistantMessage(usage: AssistantMessage["usage"], subagentId?: string) {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    model: "anthropic/claude-opus-4.8",
    usage,
  };
  return { type: "assistant_message" as const, id: randomUUID(), message, subagentId };
}

describe("installTelemetry", () => {
  afterEach(() => {
    delete process.env.ORIN_NO_TELEMETRY;
    delete process.env.ORIN_TELEMETRY_STDOUT;
  });

  it("emits a turn metric with cost + tokens on assistant_message", async () => {
    const hooks = createHookRegistry();
    const sink = collectingSink();
    installTelemetry({ hooks, sinks: [sink], sessionId: "s1", pricing });

    hooks.emit(assistantMessage({ input: 1_000_000, output: 0, totalTokens: 1_000_000 }));
    await tick();

    expect(sink.events).toHaveLength(1);
    const turn = sink.events[0];
    expect(turn.type).toBe("turn");
    if (turn.type !== "turn") throw new Error("expected turn");
    expect(turn.sessionId).toBe("s1");
    expect(turn.source).toBe("main_loop");
    expect(turn.costUsd).toBeCloseTo(15);
    expect(turn.usage.input).toBe(1_000_000);
  });

  it("tags subagent turns and skips messages without usage", async () => {
    const hooks = createHookRegistry();
    const sink = collectingSink();
    installTelemetry({ hooks, sinks: [sink], sessionId: "s1", pricing });

    hooks.emit(assistantMessage(undefined));
    hooks.emit(assistantMessage({ input: 0, output: 0, totalTokens: 0 }, "sub-1"));
    await tick();

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0].type === "turn" && sink.events[0].source).toBe("subagent");
  });

  it("measures tool duration keyed by call id (parallel-safe)", async () => {
    const hooks = createHookRegistry();
    const sink = collectingSink();
    installTelemetry({ hooks, sinks: [sink], sessionId: "s1", pricing });

    // Interleave two concurrent calls; each end must match its own start.
    hooks.emit({ type: "tool_start", id: "a", name: "read", args: {} });
    hooks.emit({ type: "tool_start", id: "b", name: "bash", args: {} });
    hooks.emit({ type: "tool_end", id: "b", name: "bash", output: "ok" });
    hooks.emit({ type: "tool_end", id: "a", name: "read", output: "ok", isError: true });
    await tick();

    const tools = sink.events.filter((e) => e.type === "tool");
    expect(tools).toHaveLength(2);
    const byId = Object.fromEntries(tools.map((t) => [t.type === "tool" ? t.id : "", t]));
    expect(byId.a.type === "tool" && byId.a.name).toBe("read");
    expect(byId.a.type === "tool" && byId.a.isError).toBe(true);
    expect(byId.b.type === "tool" && byId.b.name).toBe("bash");
    for (const t of tools) {
      expect(t.type === "tool" && typeof t.durationMs === "number" && t.durationMs >= 0).toBe(true);
    }
  });

  it("writes a session summary and flushes on session_end", async () => {
    const hooks = createHookRegistry();
    const sink = collectingSink();
    installTelemetry({ hooks, sinks: [sink], sessionId: "s1", pricing });

    hooks.emit(assistantMessage({ input: 1_000_000, output: 0, totalTokens: 1_000_000 }));
    await tick();
    await hooks.fireHook("session_end", { reason: "complete" }, ctx);

    const summaryEvent = sink.events.find((e) => e.type === "session");
    expect(summaryEvent).toBeDefined();
    if (summaryEvent?.type !== "session") throw new Error("expected session");
    expect(summaryEvent.summary.turns).toBe(1);
    expect(summaryEvent.summary.reason).toBe("complete");
    expect(summaryEvent.summary.costUsd).toBeCloseTo(15);
    expect(summaryEvent.summary.tokens.input).toBe(1_000_000);
    expect(summaryEvent.summary.modelMix["anthropic/claude-opus-4.8"].turns).toBe(1);
    expect(sink.flushed).toBe(1);
  });

  it("invokes onSessionCost with a running snapshot", async () => {
    const hooks = createHookRegistry();
    const snapshots: number[] = [];
    installTelemetry({
      hooks,
      sinks: [],
      sessionId: "s1",
      pricing,
      onSessionCost: (snap) => snapshots.push(snap.turns),
    });

    hooks.emit(assistantMessage({ input: 0, output: 0, totalTokens: 0 }));
    hooks.emit(assistantMessage({ input: 0, output: 0, totalTokens: 0 }));
    await tick();

    expect(snapshots).toEqual([1, 2]);
  });

  it("seeds running totals from a prebuilt accumulator (resume)", async () => {
    const hooks = createHookRegistry();
    const seed = new SessionCostAccumulator("s1");
    seed.recordTurn(
      {
        model: "anthropic/claude-opus-4.8",
        usage: { input: 1_000_000, output: 0, totalTokens: 1_000_000 },
        costUsd: 15,
        pricingMissing: false,
      },
      "main_loop",
    );

    const snapshots: Array<number | null> = [];
    installTelemetry({
      hooks,
      sinks: [],
      sessionId: "s1",
      pricing,
      accumulator: seed,
      onSessionCost: (snap) => snapshots.push(snap.costUsd),
    });

    hooks.emit(assistantMessage({ input: 1_000_000, output: 0, totalTokens: 1_000_000 }));
    await tick();

    // The post-turn snapshot continues from the seeded total (15 + 15).
    expect(snapshots).toEqual([30]);
    expect(seed.snapshot().turns).toBe(2);
  });

  it("recordLlmCall emits a side-path turn tagged with its source and counts it", async () => {
    const hooks = createHookRegistry();
    const sink = collectingSink();
    const { recordLlmCall } = installTelemetry({
      hooks,
      sinks: [sink],
      sessionId: "s1",
      pricing,
    });

    recordLlmCall({
      model: "anthropic/claude-opus-4.8",
      usage: { input: 1_000_000, output: 0, totalTokens: 1_000_000 },
      source: "compaction",
    });
    recordLlmCall({
      model: "anthropic/claude-opus-4.8",
      usage: { input: 0, output: 0, totalTokens: 0 },
      source: "delegate_read",
    });
    await hooks.fireHook("session_end", { reason: "complete" }, ctx);

    const turns = sink.events.filter((e) => e.type === "turn");
    expect(turns.map((t) => (t.type === "turn" ? t.source : ""))).toEqual([
      "compaction",
      "delegate_read",
    ]);

    const summary = sink.events.find((e) => e.type === "session");
    if (summary?.type !== "session") throw new Error("expected session");
    expect(summary.summary.turns).toBe(2);
    expect(summary.summary.sourceMix.compaction).toBe(1);
    expect(summary.summary.sourceMix.delegate_read).toBe(1);
    expect(summary.summary.modelMix["anthropic/claude-opus-4.8"].turns).toBe(2);
  });

  it("recordLlmCall never throws into the caller when a sink fails", () => {
    const hooks = createHookRegistry();
    const bad: MetricSink = {
      emit() {
        throw new Error("sink boom");
      },
    };
    const { recordLlmCall } = installTelemetry({ hooks, sinks: [bad], sessionId: "s1", pricing });

    expect(() =>
      recordLlmCall({
        model: "anthropic/claude-opus-4.8",
        usage: { input: 1, output: 1, totalTokens: 2 },
        source: "compaction",
      }),
    ).not.toThrow();
  });

  it("drives the injected OTel consumer through turn_start and loop_end", async () => {
    const hooks = createHookRegistry();
    const calls: string[] = [];
    const otel = {
      handleEvent: (e: { type: string }) => calls.push(`event:${e.type}`),
      endOpenTurn: (reason: string) => calls.push(`endOpen:${reason}`),
      flush: async () => {
        calls.push("flush");
      },
    };
    const { dispose } = installTelemetry({ hooks, sinks: [], sessionId: "s1", pricing, otel });

    hooks.emit({ type: "turn_start", id: "t1" });
    hooks.emit({ type: "llm_start", id: "c1", model: "m" });
    hooks.emit({ type: "loop_end", reason: "complete" });
    await tick();
    await hooks.fireHook("session_end", { reason: "complete" }, ctx);

    expect(calls).toContain("event:turn_start");
    expect(calls).toContain("event:llm_start");
    expect(calls).toContain("event:loop_end");
    expect(calls).toContain("flush");
    // dispose closes any open turn (idempotent for /new and /resume).
    dispose();
    expect(calls.filter((c) => c.startsWith("endOpen:")).length).toBeGreaterThanOrEqual(1);
  });

  it("isolates a throwing sink so others still receive events", async () => {
    const hooks = createHookRegistry();
    const bad: MetricSink = {
      emit() {
        throw new Error("sink boom");
      },
    };
    const good = collectingSink();
    installTelemetry({ hooks, sinks: [bad, good], sessionId: "s1", pricing });

    hooks.emit(assistantMessage({ input: 0, output: 0, totalTokens: 0 }));
    await tick();

    expect(good.events).toHaveLength(1);
  });
});

describe("telemetry opt-out", () => {
  afterEach(() => {
    delete process.env.ORIN_NO_TELEMETRY;
    delete process.env.ORIN_TELEMETRY_STDOUT;
  });

  it("telemetryEnabled honours ORIN_NO_TELEMETRY", () => {
    process.env.ORIN_NO_TELEMETRY = "1";
    expect(telemetryEnabled()).toBe(false);
    delete process.env.ORIN_NO_TELEMETRY;
    expect(telemetryEnabled()).toBe(true);
  });

  it("keeps the session sink but drops JSONL/stdout when opted out", () => {
    process.env.ORIN_NO_TELEMETRY = "1";
    process.env.ORIN_TELEMETRY_STDOUT = "1";
    const writes: MetricEvent[] = [];
    const sinks = createDefaultSinks({ sessionWrite: (e) => writes.push(e) });
    expect(sinks).toHaveLength(1);

    const event: MetricEvent = { type: "session", sessionId: "s1", ts: "t", summary: {
      sessionId: "s1", costUsd: null, pricingMissing: false, turns: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      modelMix: {}, sourceMix: {}, durationMs: 0, reason: "complete",
    } };
    sinks[0].emit(event);
    expect(writes).toEqual([event]);
  });

  it("includes JSONL and stdout sinks when enabled", () => {
    process.env.ORIN_TELEMETRY_STDOUT = "1";
    const sinks = createDefaultSinks({ sessionWrite: () => {} });
    // jsonl + stdout + session
    expect(sinks.length).toBe(3);
  });
});
