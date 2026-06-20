/**
 * OpenTelemetry GenAI semantic-convention attribute builders. Pure functions
 * returning plain attribute records — no OpenTelemetry import — so span shape is
 * unit-testable without the SDK and this module stays free of the lazy subtree.
 *
 * Conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
import type { CostBreakdown } from "../cost.js";

/** Attribute value kinds accepted by OTel spans. */
export type SpanAttributes = Record<string, string | number | boolean | string[]>;

/** Span name for an LLM generation: `chat {model}` per GenAI conventions. */
export function llmSpanName(model: string): string {
  return `chat ${model}`;
}

/** Request-side attributes, known when the call starts (`llm_start`). */
export function llmRequestAttributes(input: {
  requestModel: string;
  providerId?: string;
}): SpanAttributes {
  const attrs: SpanAttributes = {
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": input.requestModel,
  };
  if (input.providerId) attrs["gen_ai.provider.name"] = input.providerId;
  return attrs;
}

/**
 * Response-side attributes, known when the paired `assistant_message` arrives:
 * the response model, token usage (with custom cache_read/write), finish
 * reasons, and the computed cost.
 */
export function llmResponseAttributes(input: {
  responseModel: string;
  cost: CostBreakdown;
  finishReasons?: string[];
}): SpanAttributes {
  const { usage } = input.cost;
  const attrs: SpanAttributes = {
    "gen_ai.response.model": input.responseModel,
    "gen_ai.usage.input_tokens": usage.input,
    "gen_ai.usage.output_tokens": usage.output,
    "pricing.missing": input.cost.pricingMissing,
  };
  if (usage.cacheRead !== undefined) attrs["gen_ai.usage.cache_read_tokens"] = usage.cacheRead;
  if (usage.cacheWrite !== undefined) attrs["gen_ai.usage.cache_write_tokens"] = usage.cacheWrite;
  if (input.cost.costUsd !== null) attrs["gen_ai.usage.cost_usd"] = input.cost.costUsd;
  if (input.finishReasons?.length) attrs["gen_ai.response.finish_reasons"] = input.finishReasons;
  return attrs;
}

/** Span name for a subagent invocation: `subagent:{agent}`. */
export function subagentSpanName(agent: string): string {
  return `subagent:${agent}`;
}

/** Attributes set when a subagent span opens (`subagent_start`). */
export function subagentStartAttributes(input: {
  agent: string;
  isolation?: string;
  /** Resolved at the spawn site — per-subagent routing (#134) flows in here. */
  model?: string;
}): SpanAttributes {
  const attrs: SpanAttributes = {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": input.agent,
  };
  if (input.isolation) attrs["orin.subagent.isolation"] = input.isolation;
  if (input.model) attrs["gen_ai.request.model"] = input.model;
  return attrs;
}

/** Outcome attributes for a subagent span, set on `subagent_end`. */
export function subagentEndAttributes(input: { turns: number }): SpanAttributes {
  return { "orin.subagent.turns": input.turns };
}

/** Attributes for a tool-execution span. */
export function toolStartAttributes(input: { name: string; callId: string }): SpanAttributes {
  return {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": input.name,
    "gen_ai.tool.call.id": input.callId,
  };
}

/** Outcome attributes for a tool span, set on `tool_end`. */
export function toolEndAttributes(input: { ok: boolean; output: string }): SpanAttributes {
  return {
    "orin.tool.ok": input.ok,
    "orin.tool.output_bytes": Buffer.byteLength(input.output, "utf8"),
  };
}
