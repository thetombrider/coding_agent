/**
 * OpenTelemetry GenAI semantic-convention attribute builders. Pure functions
 * returning plain attribute records — no OpenTelemetry import — so span shape is
 * unit-testable without the SDK and this module stays free of the lazy subtree.
 *
 * Conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 *
 * Two backend-neutral additions layer on top of the GenAI baseline (telemetry
 * 7a, issue #87):
 *  - `openinference.span.kind` classifies each span (AGENT/LLM/TOOL) so Langfuse
 *    renders the right observation type. Content-free — always safe to emit.
 *  - Opt-in `input.value`/`output.value` carry lossless JSON of prompts,
 *    completions, and tool I/O. Emitted only when `captureContent` is on.
 */
import { z } from "zod";
import type { ContentBlock, Message } from "../../types.js";
import type { LlmRequestSnapshot } from "../../agent/events.js";
import type { CostBreakdown } from "../cost.js";

/** Attribute value kinds accepted by OTel spans. */
export type SpanAttributes = Record<string, string | number | boolean | string[]>;

/** OpenInference observation-type attribute key (backend-neutral; Langfuse reads it). */
export const SPAN_KIND_ATTRIBUTE = "openinference.span.kind";

/**
 * OpenInference span kinds we emit. 7b (#136) builds the full OpenInference
 * attribute set on top of these — do not duplicate that work here.
 */
export const SpanKindValue = {
  AGENT: "AGENT",
  LLM: "LLM",
  TOOL: "TOOL",
} as const;

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
    [SPAN_KIND_ATTRIBUTE]: SpanKindValue.LLM,
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
    [SPAN_KIND_ATTRIBUTE]: SpanKindValue.AGENT,
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
    [SPAN_KIND_ATTRIBUTE]: SpanKindValue.TOOL,
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

/** Ratel gateway tool spans — origin is always `agent` (ratel-hooks.md). */
export function ratelGatewayToolAttributes(): SpanAttributes {
  return { "ratel.gateway_origin": "agent" };
}

/** Ratel pre-filter metadata on LLM generation spans when replace mode is active. */
export function ratelResolutionAttributes(
  snap: NonNullable<LlmRequestSnapshot["ratel"]>,
  captureContent = false,
): SpanAttributes {
  const attrs: SpanAttributes = {
    "ratel.replace_mode": snap.replaceMode,
    "ratel.top_k": snap.topK,
    "ratel.catalog_size": snap.catalogSize,
    "ratel.injected_count": snap.injectedCount,
    "ratel.hit_count": snap.hitCount,
    "ratel.gateway_origin": snap.gatewayOrigin,
    "feature_flag": snap.featureFlag,
    "ratel.skill_catalog_size": snap.skillCatalogSize,
  };
  if (snap.topHitScore !== undefined) attrs["ratel.top_hit_score"] = snap.topHitScore;
  if (captureContent && snap.query) attrs["ratel.query"] = snap.query.slice(0, 200);
  return attrs;
}

// ---------------------------------------------------------------------------
// Trace naming (telemetry 7a) — always on, content-free privacy posture aside.
// ---------------------------------------------------------------------------

/** Max characters for a trace-root name derived from the first user message. */
const MAX_TRACE_NAME = 80;

/**
 * Name the per-turn trace root from the turn's first user message — collapsed to
 * a single line and truncated — so the Langfuse traces list is scannable. Falls
 * back to `"turn"` when no user text is available.
 */
export function traceName(firstUserText?: string): string {
  const collapsed = firstUserText?.replace(/\s+/g, " ").trim();
  if (!collapsed) return "turn";
  return collapsed.length > MAX_TRACE_NAME
    ? `${collapsed.slice(0, MAX_TRACE_NAME - 1)}…`
    : collapsed;
}

// ---------------------------------------------------------------------------
// Opt-in lossless content capture (telemetry 7a) — emitted only when
// `captureContent` is on. The exporter gates every call below.
//
// Capture data model (the forward-compat contract with 7b/#136, which derives
// its indexed OpenInference keys from this shape without re-capturing):
//
//  • LLM generation span
//      input.value  (application/json):
//        { "messages": [ { role, content?, reasoning?, tool_calls?, tool_results? }, … ],
//          "tools":    [ { name, description, json_schema? }, … ] }
//        The system prompt is the leading message with role "system".
//        → 7b derives llm.input_messages.{i}.message.role / .content /
//          .tool_calls.{j}.* and llm.tools.{i}.tool.json_schema from here.
//      output.value (application/json):
//        { role:"assistant", content?, reasoning?, tool_calls?, finish_reason? }
//        tool_calls stay structured JSON (name + parsed arguments), never prose.
//        → 7b derives llm.output_messages.0.message.* from here.
//  • Tool span
//      input.value  (application/json): the tool-call arguments.
//      output.value (text/plain | application/json): the tool result string.
//  • Subagent span
//      input.value  (text/plain): the subagent prompt.
//      output.value (text/plain): the returned summary.
// ---------------------------------------------------------------------------

const MIME_JSON = "application/json";
const MIME_TEXT = "text/plain";

/** Stringify a value to JSON, returning undefined on failure (best-effort capture). */
function safeJson(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : json;
  } catch {
    return undefined;
  }
}

/** Convert a Zod schema to JSON Schema, returning undefined if it can't be represented. */
function toJsonSchema(schema: unknown): unknown {
  try {
    return z.toJSONSchema(schema as z.ZodType);
  } catch {
    return undefined;
  }
}

/**
 * Normalise a message to the lossless capture shape: text and reasoning joined
 * per kind, tool calls and tool results preserved as structured JSON (arguments
 * stay parsed objects, never stringified prose). Empty fields are omitted.
 */
function captureMessage(message: Message): Record<string, unknown> {
  const out: Record<string, unknown> = { role: message.role };
  const texts: string[] = [];
  const reasonings: string[] = [];
  const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];
  const toolResults: Array<{
    tool_call_id: string;
    tool_name: string;
    output: string;
    is_error?: boolean;
  }> = [];

  for (const block of message.content as ContentBlock[]) {
    switch (block.type) {
      case "text":
        texts.push(block.text);
        break;
      case "reasoning":
        reasonings.push(block.text);
        break;
      case "toolCall":
        toolCalls.push({ id: block.id, name: block.name, arguments: block.arguments });
        break;
      case "toolResult":
        toolResults.push({
          tool_call_id: block.toolCallId,
          tool_name: block.toolName,
          output: block.output,
          ...(block.isError ? { is_error: true } : {}),
        });
        break;
    }
  }

  if (texts.length) out.content = texts.join("");
  if (reasonings.length) out.reasoning = reasonings.join("");
  if (toolCalls.length) out.tool_calls = toolCalls;
  if (toolResults.length) out.tool_results = toolResults;
  return out;
}

/** A content `input.value`/`output.value` pair, omitted when serialisation fails. */
function contentValue(key: "input" | "output", value: unknown, mime: string): SpanAttributes {
  const json = safeJson(value);
  return json === undefined ? {} : { [`${key}.value`]: json, [`${key}.mime_type`]: mime };
}

/** LLM `input.value`: ordered messages (system first) + tool schemas, as JSON. */
export function llmInputAttributes(request: LlmRequestSnapshot): SpanAttributes {
  const messages: Array<Record<string, unknown>> = [];
  if (request.system) messages.push({ role: "system", content: request.system });
  for (const m of request.messages) messages.push(captureMessage(m));

  const payload: Record<string, unknown> = { messages };
  if (request.tools?.length) {
    payload.tools = request.tools.map((t) => {
      const json_schema = toJsonSchema(t.schema);
      return json_schema === undefined
        ? { name: t.name, description: t.description }
        : { name: t.name, description: t.description, json_schema };
    });
  }
  return contentValue("input", payload, MIME_JSON);
}

/** LLM `output.value`: the assistant message (text + structured tool_calls) + finish reason. */
export function llmOutputAttributes(message: Message, finishReason?: string): SpanAttributes {
  const payload = captureMessage(message);
  if (finishReason) payload.finish_reason = finishReason;
  return contentValue("output", payload, MIME_JSON);
}

/** Tool `input.value`: the call arguments as JSON. Omitted when args are absent. */
export function toolInputAttributes(args: unknown): SpanAttributes {
  if (args === undefined) return {};
  return contentValue("input", args, MIME_JSON);
}

/**
 * Tool `output.value`: the raw result string, tagged `application/json` when it
 * parses as a JSON object/array, otherwise `text/plain`. The value stays the
 * verbatim string either way (lossless).
 */
export function toolOutputAttributes(output: string): SpanAttributes {
  return { "output.value": output, "output.mime_type": detectMime(output) };
}

/** Subagent `input.value`: the prompt as plain text. */
export function subagentInputAttributes(prompt: string): SpanAttributes {
  return { "input.value": prompt, "input.mime_type": MIME_TEXT };
}

/** Subagent `output.value`: the returned summary as plain text. */
export function subagentOutputAttributes(summary: string): SpanAttributes {
  return { "output.value": summary, "output.mime_type": MIME_TEXT };
}

/** Tag a string `application/json` when it parses as a JSON object/array, else `text/plain`. */
function detectMime(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(text);
      return MIME_JSON;
    } catch {
      // Not valid JSON — fall through to plain text.
    }
  }
  return MIME_TEXT;
}
