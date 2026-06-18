import { loadConfig, type ModelPricing } from "../config/config.js";
import type { HookRegistry } from "../hooks/types.js";
import type { Usage } from "../provider/types.js";
import { SessionCostAccumulator } from "./accumulator.js";
import { calcCost } from "./cost.js";
import type { MetricEvent, SessionCostSnapshot, TurnSource } from "./events.js";
import { emitAll, flushAll, jsonlSink, sessionLogSink, stdoutSink, type MetricSink } from "./sinks.js";

const now = () => new Date().toISOString();

/** Whether the JSONL/stdout sinks are allowed. The session sink ignores this. */
export function telemetryEnabled(): boolean {
  const optOut = process.env.ORIN_NO_TELEMETRY?.trim().toLowerCase();
  if (optOut === "1" || optOut === "true") return false;
  return loadConfig().telemetry.enabled !== false;
}

/**
 * Build the standard local sink list. The JSONL sink (and stdout when
 * `ORIN_TELEMETRY_STDOUT=1`) are suppressed by the telemetry opt-out, but an
 * injected session-log writer always gets a sink so the TUI/session record is
 * unaffected by the opt-out.
 */
export function createDefaultSinks(opts: {
  sessionWrite?: (event: MetricEvent) => void;
} = {}): MetricSink[] {
  const sinks: MetricSink[] = [];
  if (telemetryEnabled()) {
    sinks.push(jsonlSink(loadConfig().telemetry.metricsFile));
    if (process.env.ORIN_TELEMETRY_STDOUT?.trim() === "1") sinks.push(stdoutSink());
  }
  if (opts.sessionWrite) sinks.push(sessionLogSink(opts.sessionWrite));
  return sinks;
}

export interface InstallTelemetryOptions {
  hooks: Pick<HookRegistry, "observe" | "on">;
  sinks: readonly MetricSink[];
  sessionId: string;
  providerId?: string;
  /** Pricing table override — defaults to `loadConfig().models.pricing`. */
  pricing?: Record<string, ModelPricing>;
  /** Called with a fresh snapshot after every turn (for the TUI badge, issue 8/8). */
  onSessionCost?: (snapshot: SessionCostSnapshot) => void;
}

/**
 * Subscribe a session's hooks to the metric pipeline: each `assistant_message`
 * becomes a `turn` metric (cost + tokens), each tool call a `tool` metric
 * (duration keyed by call id, parallel-safe), and `session_end` a `session`
 * summary followed by a flush. Returns a disposer that unsubscribes everything.
 */
export function installTelemetry(opts: InstallTelemetryOptions): () => void {
  const { hooks, sinks, sessionId, providerId, onSessionCost } = opts;
  const pricing = opts.pricing ?? loadConfig().models.pricing;
  const acc = new SessionCostAccumulator(sessionId);
  const startMs = Date.now();
  /** tool-call id → start time, so parallel calls measure their own duration. */
  const toolStarts = new Map<string, number>();

  const unsubObserve = hooks.observe((event) => {
    if (event.type === "assistant_message") {
      const { message } = event;
      if (!message.usage) return;
      const source: TurnSource = event.subagentId ? "subagent" : "main_loop";
      const breakdown = calcCost(message.model, message.usage, pricing, providerId);
      acc.recordTurn(breakdown, source);
      emitAll(sinks, { type: "turn", sessionId, ts: now(), ...breakdown, source });
      onSessionCost?.(acc.snapshot());
    } else if (event.type === "tool_start") {
      toolStarts.set(event.id, Date.now());
    } else if (event.type === "tool_end") {
      const started = toolStarts.get(event.id);
      toolStarts.delete(event.id);
      const durationMs = started !== undefined ? Date.now() - started : 0;
      emitAll(sinks, {
        type: "tool",
        sessionId,
        ts: now(),
        id: event.id,
        name: event.name,
        durationMs,
        isError: event.isError,
        subagentId: event.subagentId,
      });
    }
  });

  const unsubEnd = hooks.on("session_end", async (payload) => {
    const summary = acc.finalize(Date.now() - startMs, payload.reason);
    emitAll(sinks, { type: "session", sessionId, ts: now(), summary });
    await flushAll(sinks);
  });

  return () => {
    unsubObserve();
    unsubEnd();
  };
}

/**
 * Record an LLM call that doesn't surface as an `assistant_message` event —
 * e.g. compaction or the cheap-model side path (issue 3/8). Updates the
 * accumulator and emits a `turn` metric.
 */
export function recordLlmCall(
  acc: SessionCostAccumulator,
  sinks: readonly MetricSink[],
  call: {
    model: string;
    usage: Usage;
    source: TurnSource;
    providerId?: string;
    pricing?: Record<string, ModelPricing>;
  },
): void {
  const pricing = call.pricing ?? loadConfig().models.pricing;
  const breakdown = calcCost(call.model, call.usage, pricing, call.providerId);
  acc.recordTurn(breakdown, call.source);
  emitAll(sinks, {
    type: "turn",
    sessionId: acc.sessionId,
    ts: now(),
    ...breakdown,
    source: call.source,
  });
}
