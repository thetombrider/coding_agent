import { loadConfig, type ModelPricing } from "../config/config.js";
import type { HookRegistry } from "../hooks/types.js";
import type { Usage } from "../provider/types.js";
import { SessionCostAccumulator } from "./accumulator.js";
import { calcCost } from "./cost.js";
import type { LlmCallRecorder, MetricEvent, SessionCostSnapshot, TurnSource } from "./events.js";
import { emitAll, flushAll, jsonlSink, sessionLogSink, stdoutSink, type MetricSink } from "./sinks.js";
import { createOtelSpanConsumer, type OtelSpanConsumer } from "./otel/exporter.js";

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
  /**
   * OTLP span consumer override (issue 5/8). When omitted, one is built from
   * the resolved OTel config (a no-op unless an endpoint is configured). Tests
   * inject an InMemory-backed consumer here.
   */
  otel?: OtelSpanConsumer;
}

/** Handle returned by {@link installTelemetry}. */
export interface InstalledTelemetry {
  /** Unsubscribes every hook this install added. */
  dispose: () => void;
  /**
   * Records a side-path LLM call (compaction, delegate_read) into this
   * session's accumulator + sinks. Best-effort — never throws into the caller.
   */
  recordLlmCall: LlmCallRecorder;
}

/**
 * Subscribe a session's hooks to the metric pipeline: each `assistant_message`
 * becomes a `turn` metric (cost + tokens), each tool call a `tool` metric
 * (duration keyed by call id, parallel-safe), and `session_end` a `session`
 * summary followed by a flush. Returns a {@link InstalledTelemetry} handle with
 * a disposer plus a recorder for side-path calls that bypass `runLoop`.
 */
export function installTelemetry(opts: InstallTelemetryOptions): InstalledTelemetry {
  const { hooks, sinks, sessionId, providerId, onSessionCost } = opts;
  const pricing = opts.pricing ?? loadConfig().models.pricing;
  const acc = new SessionCostAccumulator(sessionId);
  const startMs = Date.now();
  /** tool-call id → start time, so parallel calls measure their own duration. */
  const toolStarts = new Map<string, number>();

  // OTLP trace export (issue 5/8). Undefined unless an endpoint is configured.
  // The session_start hook fires before this install in the TUI, so open the
  // trace root here (the install moment is the session boundary) and close it
  // on session_end / dispose.
  const otel = opts.otel ?? createOtelSpanConsumer({ sessionId, providerId, pricing });
  otel?.startSession();

  const unsubObserve = hooks.observe((event) => {
    otel?.handleEvent(event);
    if (event.type === "assistant_message") {
      const { message } = event;
      if (!message.usage) return;
      const source: TurnSource = event.subagentId ? "subagent" : "main_loop";
      const breakdown = calcCost(message.model, message.usage, pricing, providerId);
      acc.recordTurn(breakdown, source);
      emitAll(sinks, { type: "turn", sessionId, ts: now(), ...breakdown, source });
      if (onSessionCost) {
        try {
          onSessionCost(acc.snapshot());
        } catch {
          // A throwing consumer must never propagate into the agent loop.
        }
      }
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
    if (otel) {
      otel.endSession(payload.reason);
      await otel.flush();
    }
    await flushAll(sinks);
  });

  const recordSideLlmCall: LlmCallRecorder = (call) => {
    try {
      recordLlmCall(acc, sinks, { ...call, providerId, pricing });
    } catch {
      // Best-effort: a telemetry failure must never break the caller
      // (compaction / delegate_read).
    }
  };

  return {
    dispose: () => {
      unsubObserve();
      unsubEnd();
      // /new and /resume reinstall without firing session_end, so close and
      // flush the trace root here too. Idempotent with the session_end path.
      if (otel) {
        otel.endSession("complete");
        void otel.flush();
      }
    },
    recordLlmCall: recordSideLlmCall,
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
