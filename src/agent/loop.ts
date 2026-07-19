import { tool } from "ai";
import { randomUUID } from "node:crypto";
import type { HookRegistryImpl } from "../hooks/registry.js";
import type { StreamAssistantFn, AssistantMessage } from "../provider/types.js";
import { enrichAssistantMessage, formatToolValidationErrors } from "../provider/tool-call-parser.js";
import type { AnyTool } from "../tools/registry.js";
import type { OrinRatelBundle } from "../ratel/catalog.js";
import { INVOKE_TOOL_ID } from "../ratel/catalog.js";
import type { AgentContext, Message, SessionEventCallback } from "../types.js";
import { activeProviderId } from "../provider/registry.js";
import { resolveProviderSlot } from "../config/models.js";
import { resolvePath } from "../util/paths.js";
import {
  compactMessages,
  computePromptShapeKey,
  currentTurnCount,
  estimateInjectionTokens,
  evictStaleToolResults,
  shouldCompact,
  type ProviderOverhead,
} from "./compaction.js";
import { getContextWindow } from "../provider/context-window.js";
import { MutationQueue, mutationLocks, runWithMutationLocks } from "./mutation-queue.js";
import { isAbortError } from "../util/abort.js";
import { isCriticalSystemError, isRateLimitError } from "../util/system-error.js";

const RATE_LIMIT_MAX_RETRIES = 3;
const RATE_LIMIT_BASE_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
import { executeHookedTool } from "./tool-execution.js";

const CONTEXT_FULL_MESSAGE =
  "The conversation context is full and automatic compaction could not reduce it further. "
  + "Start a new session (/sessions) or send a shorter message to continue.";

import {
  EMPTY_RESPONSE_MESSAGE,
  EMPTY_RESPONSE_NUDGE,
} from "./empty-response.js";

function loopLimitMessage(kind: "turns" | "tools", limit: number): string {
  const what = kind === "turns" ? "assistant round" : "tool call";
  return (
    `Reached the per-turn ${what} limit (${limit}). `
    + "Send another message to continue, or adjust limits with /settings loop."
  );
}

function assistantMessageText(message: AssistantMessage): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
}

function isEmptyAssistantResponse(message: AssistantMessage, toolCalls: ToolCallBlock[]): boolean {
  return toolCalls.length === 0 && assistantMessageText(message) === "";
}

function pushAssistantNotice(
  ctx: AgentContext,
  hooks: HookRegistryImpl,
  options: RunLoopOptions,
  text: string,
): void {
  const ts = () => new Date().toISOString();
  const content = [{ type: "text" as const, text }];
  const message: AssistantMessage = {
    role: "assistant",
    content,
    model: options.model,
  };
  ctx.messages.push(message);
  options.onEvent?.({ type: "assistant_chunk", ts: ts(), content });
  hooks.emit({ type: "text_delta", text });
  hooks.emit({ type: "assistant_message", id: randomUUID(), message });
}

export interface RunLoopOptions {
  provider: StreamAssistantFn;
  /** Full execution registry — all tools the loop may run (including via invoke_tool). */
  tools: AnyTool[];
  model: string;
  system?: string;
  signal?: AbortSignal;
  /** OpenRouter session id for sticky routing across turns and tool rounds. */
  sessionId?: string;
  onEvent?: SessionEventCallback;
  /** Cap assistant turns — used by subagent child loops. */
  maxTurns?: number;
  /** Cap cumulative tool calls across all turns — used by subagent child loops. */
  maxToolCalls?: number;
  /** When set, BM25 pre-filter + gateway tools are resolved per LLM call (issue #295). */
  ratel?: OrinRatelBundle;
  /** A/B control-arm tag — emitted as `featureFlag` on `llm_start` when ratel is absent. */
  featureFlag?: string;
}

interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}

interface ExecutedTool {
  message: Message;
  terminate?: boolean;
  /** Set when termination is driven by an unrecoverable system failure. */
  systemError?: boolean;
}

function toolMap(tools: AnyTool[]): Map<string, AnyTool> {
  return new Map(tools.map((t) => [t.name, t]));
}

function toProviderTools(tools: AnyTool[]) {
  return Object.fromEntries(
    tools.map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: t.schema,
      }),
    ]),
  );
}

function toolResultMessage(
  toolCallId: string,
  toolName: string,
  output: string,
  isError?: boolean,
): Message {
  return {
    role: "tool",
    content: [{ type: "toolResult", toolCallId, toolName, output, isError }],
  };
}

function validateToolCalls(
  calls: ToolCallBlock[],
  registry: Map<string, AnyTool>,
): Array<{ name: string; message: string }> {
  const errors: Array<{ name: string; message: string }> = [];

  for (const call of calls) {
    const tool = registry.get(call.name);
    if (!tool) {
      errors.push({ name: call.name, message: `Unknown tool: ${call.name}` });
      continue;
    }

    const parsed = tool.schema.safeParse(call.arguments);
    if (!parsed.success) {
      errors.push({ name: call.name, message: parsed.error.message });
    }
  }

  return errors;
}

async function executeSingleTool(
  call: ToolCallBlock,
  registry: Map<string, AnyTool>,
  ctx: AgentContext,
  hooks: HookRegistryImpl,
  options: RunLoopOptions,
  ts: () => string,
): Promise<ExecutedTool> {
  const tool = registry.get(call.name);
  if (!tool) {
    const output = `Unknown tool: ${call.name}`;
    const msg = toolResultMessage(call.id, call.name, output, true);
    options.onEvent?.({ type: "tool_result", ts: ts(), toolUseId: call.id, content: msg.content });
    hooks.emit({ type: "tool_end", id: call.id, name: call.name, output, isError: true });
    return { message: msg };
  }

  const argsResult = tool.schema.safeParse(call.arguments);
  if (!argsResult.success) {
    const output = argsResult.error.message;
    const msg = toolResultMessage(call.id, call.name, output, true);
    options.onEvent?.({ type: "tool_result", ts: ts(), toolUseId: call.id, content: msg.content });
    hooks.emit({ type: "tool_end", id: call.id, name: call.name, output, isError: true });
    return { message: msg };
  }

  const args = argsResult.data;

  const prevInvokeCallId = ctx.invokeToolCallId;
  if (call.name === INVOKE_TOOL_ID) ctx.invokeToolCallId = call.id;

  try {
    for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt += 1) {
      try {
        const result = await executeHookedTool({
          call: { id: call.id, name: call.name, args },
          tool,
          ctx,
          hooks,
          signal: options.signal ?? new AbortController().signal,
        });

        const msg = toolResultMessage(call.id, call.name, result.output, result.isError);
        options.onEvent?.({ type: "tool_result", ts: ts(), toolUseId: call.id, content: msg.content });
        return { message: msg, terminate: result.terminate };
      } catch (err) {
        if (isRateLimitError(err) && attempt < RATE_LIMIT_MAX_RETRIES) {
          await sleep(RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }

        const detail = err instanceof Error ? err.message : String(err);
        const critical = isCriticalSystemError(err);
        // A critical system error (disk full, read-only FS, fd exhaustion, OOM,
        // auth failure, network partition…) is environmental: retrying the same —
        // or any — call is futile. Surface it distinctly and terminate the loop
        // instead of letting the model retry it indefinitely. Recoverable tool
        // errors (including exhausted rate limits) are returned for the model.
        const output = critical ? `Critical system error — aborting agent loop: ${detail}` : detail;
        const msg = toolResultMessage(call.id, call.name, output, true);
        options.onEvent?.({ type: "tool_result", ts: ts(), toolUseId: call.id, content: msg.content });
        hooks.emit({ type: "tool_end", id: call.id, name: call.name, output, isError: true });
        return critical ? { message: msg, terminate: true, systemError: true } : { message: msg };
      }
    }
    throw new Error("rate limit retries exhausted");
  } finally {
    if (call.name === INVOKE_TOOL_ID) {
      ctx.invokeToolCallId = prevInvokeCallId;
    }
  }
}

async function executeToolsParallel(
  calls: ToolCallBlock[],
  registry: Map<string, AnyTool>,
  ctx: AgentContext,
  hooks: HookRegistryImpl,
  options: RunLoopOptions,
  ts: () => string,
): Promise<ExecutedTool[]> {
  const mutationQueue = new MutationQueue();
  const batchAbort = new AbortController();
  const parentSignal = options.signal;
  const onParentAbort = () => batchAbort.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    batchAbort.abort(parentSignal.reason);
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  const batchOptions: RunLoopOptions = { ...options, signal: batchAbort.signal };

  try {
    return await Promise.all(
      calls.map((call) => {
        const locks = mutationLocks(call.name, call.arguments, resolvePath, ctx.cwd);
        const run = () => executeSingleTool(call, registry, ctx, hooks, batchOptions, ts);
        return runWithMutationLocks(mutationQueue, locks, run).then((result) => {
          if (result.terminate) batchAbort.abort();
          return result;
        });
      }),
    );
  } finally {
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

/**
 * The text of the turn's initiating user message — the most recent user message
 * at turn start — used to name the OTel trace root (telemetry 7a). Returns
 * undefined when no user text is present (the trace falls back to "turn").
 */
function latestUserText(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const text = m.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();
    if (text) return text;
  }
  return undefined;
}

async function resolvePromptContext(
  ctx: AgentContext,
  hooks: HookRegistryImpl,
  options: RunLoopOptions,
): Promise<{
  promptMessages: Message[];
  providerTools: AnyTool[];
  overhead: ProviderOverhead;
  ratelResolution: ReturnType<NonNullable<OrinRatelBundle["resolveToolsForTurn"]>> | undefined;
}> {
  let promptMessages = ctx.messages;
  const promptHook = await hooks.fireHook(
    "before_prompt",
    { messages: promptMessages, model: options.model },
    ctx,
    options.signal,
  );
  if (promptHook && "messages" in promptHook) {
    promptMessages = promptHook.messages;
  }

  const userQuery = latestUserText(ctx.messages) ?? "";
  const ratelResolution = options.ratel?.resolveToolsForTurn(userQuery);
  const providerTools = ratelResolution?.tools ?? options.tools;

  const overhead: ProviderOverhead = {
    system: options.system,
    tools: providerTools,
    injectionTokens: estimateInjectionTokens(promptMessages, ctx.messages),
  };

  return { promptMessages, providerTools, overhead, ratelResolution };
}

export async function runLoop(
  ctx: AgentContext,
  hooks: HookRegistryImpl,
  options: RunLoopOptions,
): Promise<AgentContext> {
  const registry = toolMap(options.tools);
  let parseCorrectionRetries = 0;
  let emptyResponseRetries = 0;
  let assistantTurns = 0;
  let totalToolCalls = 0;
  let lastKnownInputTokens = 0;
  let lastPromptShapeKey = "";

  const turnId = randomUUID();
  hooks.emit({ type: "turn_start", id: turnId, firstUserText: latestUserText(ctx.messages) });

  while (true) {
    if (options.signal?.aborted) {
      hooks.emit({ type: "loop_end", reason: "cancelled" });
      break;
    }

    if (options.maxTurns !== undefined && assistantTurns >= options.maxTurns) {
      pushAssistantNotice(ctx, hooks, options, loopLimitMessage("turns", options.maxTurns));
      hooks.emit({ type: "loop_end", reason: "terminate" });
      break;
    }

    const contextWindow = await getContextWindow(options.model);

    const turnIndex = currentTurnCount(ctx.messages);
    ctx.messages = evictStaleToolResults(ctx.messages, turnIndex);

    let { promptMessages, providerTools, overhead, ratelResolution } = await resolvePromptContext(
      ctx,
      hooks,
      options,
    );
    const knownTools = new Set(providerTools.map((t) => t.name));

    const promptShapeKey = computePromptShapeKey(
      options.system,
      providerTools,
      promptMessages,
      ctx.messages,
    );
    if (promptShapeKey !== lastPromptShapeKey) {
      lastKnownInputTokens = 0;
      lastPromptShapeKey = promptShapeKey;
    }

    const compactionOptions = {
      knownTokens: lastKnownInputTokens || undefined,
      overhead,
    };
    const compactionNeeded = shouldCompact(ctx.messages, contextWindow, compactionOptions);
    if (compactionNeeded) {
      await hooks.fireHook("before_compact", { messages: ctx.messages }, ctx, options.signal);
      const compactionModel = resolveProviderSlot(activeProviderId(), "compaction");
      ctx.messages = await compactMessages(
        ctx.messages,
        compactionModel,
        contextWindow,
        undefined,
        undefined,
        ctx.loopHost?.recordLlmCall,
        options.signal,
        overhead,
      );

      if (options.signal?.aborted) {
        hooks.emit({ type: "loop_end", reason: "cancelled" });
        break;
      }

      // Messages changed — provider usage from the previous call is stale.
      lastKnownInputTokens = 0;
      ({ promptMessages, providerTools, overhead, ratelResolution } = await resolvePromptContext(
        ctx,
        hooks,
        options,
      ));

      if (shouldCompact(ctx.messages, contextWindow, { overhead })) {
        pushAssistantNotice(ctx, hooks, options, CONTEXT_FULL_MESSAGE);
        hooks.emit({ type: "loop_end", reason: "error" });
        break;
      }
    }

    const llmCallId = randomUUID();
    hooks.emit({
      type: "llm_start",
      id: llmCallId,
      model: options.model,
      // Carried by reference for opt-in content capture (telemetry 7a). The OTel
      // exporter snapshots it to JSON only when captureContent is on, so there is
      // no cost here when it is off (the default).
      request: {
        system: options.system,
        messages: promptMessages,
        tools: providerTools,
        ...(ratelResolution ? { ratel: ratelResolution.telemetry } : {}),
        // Control-arm tag: present only when ratel is absent (A/B split).
        ...(options.featureFlag && !ratelResolution ? { featureFlag: options.featureFlag } : {}),
      },
    });

    let rawMessage;
    try {
      rawMessage = await options.provider(
        promptMessages,
        {
          model: options.model,
          system: options.system,
          tools: toProviderTools(providerTools),
          signal: options.signal,
          sessionId: options.sessionId,
        },
        (event) => {
          if (event.type === "text_delta") hooks.emit({ type: "text_delta", text: event.text });
          if (event.type === "reasoning_delta") {
            hooks.emit({ type: "reasoning_delta", text: event.text });
          }
          if (event.type === "tool_input_start") {
            hooks.emit({ type: "tool_input_start", id: event.id, name: event.name });
          }
          if (event.type === "tool_input_delta") {
            hooks.emit({
              type: "tool_input_delta",
              id: event.id,
              name: event.name,
              chars: event.chars,
            });
          }
        },
      );
    } catch (err) {
      if (options.signal?.aborted || isAbortError(err)) {
        hooks.emit({ type: "loop_end", reason: "cancelled" });
        break;
      }
      throw err;
    }

    if ((rawMessage.usage?.input ?? 0) > 0) {
      lastKnownInputTokens = rawMessage.usage!.input;
    }

    const { message, usedFallback } = enrichAssistantMessage(rawMessage, knownTools);
    const ts = () => new Date().toISOString();
    const toolCalls = message.content.filter((c): c is ToolCallBlock => c.type === "toolCall");
    const fromText = message.toolCallsFromText ?? usedFallback;

    if (toolCalls.length > 0 && parseCorrectionRetries < 2) {
      const validationErrors = validateToolCalls(toolCalls, registry);
      if (validationErrors.length > 0) {
        const correction = formatToolValidationErrors(validationErrors, fromText);
        ctx.messages.push(message);
        options.onEvent?.({ type: "assistant_chunk", ts: ts(), content: message.content });
        hooks.emit({ type: "assistant_message", id: llmCallId, message });
        ctx.messages.push({
          role: "user",
          content: [{ type: "text", text: correction }],
        });
        options.onEvent?.({
          type: "user_message",
          ts: ts(),
          content: [{ type: "text", text: correction }],
        });
        parseCorrectionRetries += 1;
        continue;
      }
    }

    parseCorrectionRetries = 0;

    if (toolCalls.length === 0 && isEmptyAssistantResponse(message, toolCalls)) {
      if (emptyResponseRetries < 1) {
        emptyResponseRetries += 1;
        const nudge = [{ type: "text" as const, text: EMPTY_RESPONSE_NUDGE }];
        ctx.messages.push({ role: "user", content: nudge });
        options.onEvent?.({ type: "user_message", ts: ts(), content: nudge });
        continue;
      }
      pushAssistantNotice(ctx, hooks, options, EMPTY_RESPONSE_MESSAGE);
      hooks.emit({ type: "loop_end", reason: "complete" });
      break;
    }

    emptyResponseRetries = 0;
    assistantTurns += 1;
    ctx.messages.push(message);
    options.onEvent?.({ type: "assistant_chunk", ts: ts(), content: message.content });
    hooks.emit({ type: "assistant_message", id: llmCallId, message });

    if (toolCalls.length === 0) {
      hooks.emit({ type: "loop_end", reason: "complete" });
      break;
    }

    const results = await executeToolsParallel(toolCalls, registry, ctx, hooks, options, ts);

    let terminateReason: "terminate" | "error" | undefined;
    for (const result of results) {
      ctx.messages.push(result.message);
      if (result.terminate) {
        // System failures end the loop with reason "error"; a deliberate tool
        // terminate (e.g. task) ends it with reason "terminate". Push every
        // result before returning so no tool call is left without a result.
        terminateReason = result.systemError ? "error" : (terminateReason ?? "terminate");
      }
    }
    if (terminateReason) {
      hooks.emit({ type: "loop_end", reason: terminateReason });
      return ctx;
    }

    totalToolCalls += toolCalls.length;
    if (options.maxToolCalls !== undefined && totalToolCalls >= options.maxToolCalls) {
      pushAssistantNotice(ctx, hooks, options, loopLimitMessage("tools", options.maxToolCalls));
      hooks.emit({ type: "loop_end", reason: "terminate" });
      break;
    }
  }

  return ctx;
}

export function lastAssistantText(ctx: AgentContext): string {
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const m = ctx.messages[i];
    if (m.role !== "assistant") continue;
    const text = m.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    if (text) return text;
  }
  return "";
}
