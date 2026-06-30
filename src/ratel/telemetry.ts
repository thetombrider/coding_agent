import {
  GET_SKILL_CONTENT_ID,
  INVOKE_TOOL_ID,
  SEARCH_CAPABILITIES_ID,
  type OrinRatelBundle,
} from "./catalog.js";
import type { RatelResolutionSnapshot } from "../agent/events.js";
import type { HookRegistry } from "../hooks/types.js";
import { emitAll, type MetricSink } from "../telemetry/sinks.js";
import type { SpanAttributes } from "../telemetry/otel/semconv.js";
import { ratelResolutionAttributes as ratelResolutionAttrs } from "../telemetry/otel/semconv.js";

const GATEWAY_TOOL_IDS = new Set([
  SEARCH_CAPABILITIES_ID,
  INVOKE_TOOL_ID,
  GET_SKILL_CONTENT_ID,
]);

export function isRatelGatewayTool(name: string): boolean {
  return GATEWAY_TOOL_IDS.has(name as typeof SEARCH_CAPABILITIES_ID);
}

/** OTel / Langfuse-friendly attributes for a pre-filter LLM call (ratel-hooks.md). */
export function ratelResolutionAttributes(snap: RatelResolutionSnapshot): SpanAttributes {
  return ratelResolutionAttrs(snap);
}

/** Map a Ratel core trace envelope to metric + span attributes. */
export function normalizeRatelTraceEvent(raw: unknown): {
  name: string;
  attributes: SpanAttributes;
} | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const event = raw as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : undefined;
  if (!type) return undefined;

  const attrs: SpanAttributes = {};
  const str = (k: string) => {
    const v = event[k];
    if (typeof v === "string") attrs[`ratel.${k}`] = v;
  };
  const num = (k: string) => {
    const v = event[k];
    if (typeof v === "number") attrs[`ratel.${k}`] = v;
  };

  switch (type) {
    case "gateway_search":
      return {
        name: "ratel.search_capabilities",
        attributes: {
          "ratel.event": type,
          "ratel.gateway_origin": "agent",
          ...(typeof event.query === "string" ? { "ratel.query": event.query.slice(0, 200) } : {}),
          ...(typeof event.top_k === "number" ? { "ratel.top_k": event.top_k } : {}),
          ...(typeof event.hits === "number" ? { "ratel.hit_count": event.hits } : {}),
          ...(typeof event.took_ms === "number" ? { "ratel.took_ms": event.took_ms } : {}),
        },
      };
    case "gateway_invoke":
      return {
        name: "ratel.invoke_tool",
        attributes: {
          "ratel.event": type,
          "ratel.gateway_origin": "agent",
          ...(typeof event.tool_id === "string" ? { "ratel.tool_id": event.tool_id } : {}),
          ...(typeof event.took_ms === "number" ? { "ratel.took_ms": event.took_ms } : {}),
        },
      };
    case "skill_search":
      return {
        name: "ratel.skill_search",
        attributes: {
          "ratel.event": type,
          "ratel.gateway_origin":
            event.origin === "agent" || event.origin === "direct" ? event.origin : "agent",
          ...(typeof event.query === "string" ? { "ratel.query": event.query.slice(0, 200) } : {}),
          ...(typeof event.top_k === "number" ? { "ratel.top_k": event.top_k } : {}),
          ...(typeof event.hits === "number" ? { "ratel.hit_count": event.hits } : {}),
        },
      };
    case "skill_invoke":
      return {
        name: "ratel.get_skill_content",
        attributes: {
          "ratel.event": type,
          "ratel.gateway_origin": "agent",
          ...(typeof event.skill_id === "string" ? { "ratel.skill_id": event.skill_id } : {}),
          ...(typeof event.took_ms === "number" ? { "ratel.took_ms": event.took_ms } : {}),
        },
      };
    case "invoke_start":
    case "invoke_end":
    case "invoke_error":
    case "gateway_error":
    case "upstream_register":
    case "upstream_invoke":
    case "upstream_error":
      str("tool_id");
      str("error");
      str("server");
      num("took_ms");
      num("tool_count");
      return { name: `ratel.${type}`, attributes: { "ratel.event": type, ...attrs } };
    default:
      return { name: `ratel.${type}`, attributes: { "ratel.event": type } };
  }
}

export interface InstallRatelTelemetryOptions {
  hooks: Pick<HookRegistry, "observe">;
  sessionId: string;
  sinks: readonly MetricSink[];
  getBundle: () => OrinRatelBundle | undefined;
}

/** Drain Ratel trace events after gateway tool calls and emit `ratel` metrics. */
export function installRatelTelemetry(opts: InstallRatelTelemetryOptions): () => void {
  const { hooks, sessionId, sinks, getBundle } = opts;
  const ts = () => new Date().toISOString();

  // Gap 2: track the injected tool set from the most recent LLM call for
  // stranded-tool detection — populated on every llm_start with ratel data.
  let lastInjectedTools = new Set<string>();

  const forwardBundleTraces = () => {
    const bundle = getBundle();
    if (!bundle) return;
    for (const raw of bundle.drainTraceEvents()) {
      const normalized = normalizeRatelTraceEvent(raw);
      if (!normalized) continue;
      emitAll(sinks, {
        type: "ratel",
        sessionId,
        ts: ts(),
        name: normalized.name,
        attributes: normalized.attributes as Record<string, string | number | boolean>,
      });
    }
  };

  return hooks.observe((event) => {
    if (event.type === "llm_start") {
      if (event.request?.ratel) {
        // Treatment arm: snapshot injected tools, emit prefilter metric, drain traces.
        lastInjectedTools = new Set(event.request.ratel.injectedToolNames);
        emitRatelPrefilterMetric(sinks, sessionId, event.request.ratel);
        const bundle = getBundle();
        if (bundle) {
          emitRatelTraceMetrics(sinks, sessionId, bundle.drainTraceEvents());
        }
      } else if (event.request?.featureFlag) {
        // Gap 1: control arm — emit a minimal feature_flag metric so the
        // Token Cost & Savings dashboard can split by arm even without ratel data.
        emitAll(sinks, {
          type: "ratel",
          sessionId,
          ts: ts(),
          name: "ratel.control_arm",
          attributes: { "feature_flag": event.request.featureFlag },
        });
      }
    }

    if (event.type === "tool_end") {
      if (isRatelGatewayTool(event.name)) {
        forwardBundleTraces();
      } else if (lastInjectedTools.size > 0 && !lastInjectedTools.has(event.name)) {
        // Gap 2: tool was executed but was NOT in the LLM's injected tool set.
        // If it exists in the catalog, Ratel filtered it — emit the guardrail score.
        const bundle = getBundle();
        if (bundle?.getOrinTool(event.name)) {
          emitAll(sinks, {
            type: "ratel",
            sessionId,
            ts: ts(),
            name: "ratel.unavailable_tool_call",
            attributes: {
              "ratel.tool_id": event.name,
              "feature_flag": "tool_pool=ratel",
            },
          });
        }
      }
    }
  });
}

export function emitRatelPrefilterMetric(
  sinks: readonly MetricSink[],
  sessionId: string,
  snap: RatelResolutionSnapshot,
): void {
  emitAll(sinks, {
    type: "ratel",
    sessionId,
    ts: new Date().toISOString(),
    name: "ratel.prefilter",
    attributes: ratelResolutionAttributes(snap) as Record<string, string | number | boolean>,
  });
}

export function emitRatelTraceMetrics(
  sinks: readonly MetricSink[],
  sessionId: string,
  rawEvents: unknown[],
): void {
  const ts = new Date().toISOString();
  for (const raw of rawEvents) {
    const normalized = normalizeRatelTraceEvent(raw);
    if (!normalized) continue;
    emitAll(sinks, {
      type: "ratel",
      sessionId,
      ts,
      name: normalized.name,
      attributes: normalized.attributes as Record<string, string | number | boolean>,
    });
  }
}
