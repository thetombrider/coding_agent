import { tool } from "ai";
import type { HookRegistryImpl } from "../hooks/registry.js";
import type { StreamAssistantFn } from "../provider/types.js";
import { enrichAssistantMessage, formatToolValidationErrors } from "../provider/tool-call-parser.js";
import type { AnyTool } from "../tools/registry.js";
import type { AgentContext, Message, SessionEventCallback } from "../types.js";
import { defaultCheapModel } from "../config/models.js";
import { resolvePath } from "../util/paths.js";
import {
  currentTurnCount,
  evictStaleToolResults,
  shouldCompact,
  summariseOldTurns,
} from "./compaction.js";
import { getContextWindow } from "../provider/context-window.js";
import { MutationQueue, writeMutationKey } from "./mutation-queue.js";

export interface RunLoopOptions {
  provider: StreamAssistantFn;
  tools: AnyTool[];
  model: string;
  /** Cheap model used for context compaction summarisation. */
  cheapModel?: string;
  system?: string;
  signal?: AbortSignal;
  /** OpenRouter session id for sticky routing across turns and tool rounds. */
  sessionId?: string;
  onEvent?: SessionEventCallback;
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

function toolResultMessage(toolCallId: string, output: string, isError?: boolean): Message {
  return {
    role: "tool",
    content: [{ type: "toolResult", toolCallId, output, isError }],
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
    const msg = toolResultMessage(call.id, output, true);
    options.onEvent?.({ type: "tool_result", ts: ts(), toolUseId: call.id, content: msg.content });
    hooks.emit({ type: "tool_end", id: call.id, name: call.name, output, isError: true });
    return { message: msg };
  }

  const argsResult = tool.schema.safeParse(call.arguments);
  if (!argsResult.success) {
    const output = argsResult.error.message;
    const msg = toolResultMessage(call.id, output, true);
    options.onEvent?.({ type: "tool_result", ts: ts(), toolUseId: call.id, content: msg.content });
    hooks.emit({ type: "tool_end", id: call.id, name: call.name, output, isError: true });
    return { message: msg };
  }

  const args = argsResult.data;

  const hookResult = await hooks.fireHook(
    "before_tool",
    { id: call.id, name: call.name, args },
    ctx,
    options.signal,
  );
  if (hookResult && "block" in hookResult && hookResult.block) {
    const output = `[Blocked: ${hookResult.reason}]`;
    const msg = toolResultMessage(call.id, output, true);
    options.onEvent?.({ type: "tool_result", ts: ts(), toolUseId: call.id, content: msg.content });
    hooks.emit({ type: "tool_end", id: call.id, name: call.name, output, isError: true });
    return { message: msg };
  }

  const effectiveArgs = hookResult && "args" in hookResult ? hookResult.args : args;
  hooks.emit({ type: "tool_start", id: call.id, name: call.name, args: effectiveArgs });

  try {
    const result = await tool.execute(
      effectiveArgs,
      ctx,
      options.signal ?? new AbortController().signal,
    );
    let output = result.output;
    const afterResult = await hooks.fireHook(
      "after_tool",
      { name: call.name, args: effectiveArgs, output },
      ctx,
      options.signal,
    );
    if (afterResult && "output" in afterResult) {
      output = afterResult.output;
    }

    const msg = toolResultMessage(call.id, output, result.isError);
    options.onEvent?.({ type: "tool_result", ts: ts(), toolUseId: call.id, content: msg.content });
    hooks.emit({
      type: "tool_end",
      id: call.id,
      name: call.name,
      output,
      isError: result.isError,
    });
    return { message: msg, terminate: result.terminate };
  } catch (err) {
    const output = err instanceof Error ? err.message : String(err);
    const msg = toolResultMessage(call.id, output, true);
    options.onEvent?.({ type: "tool_result", ts: ts(), toolUseId: call.id, content: msg.content });
    hooks.emit({ type: "tool_end", id: call.id, name: call.name, output, isError: true });
    return { message: msg };
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

  return Promise.all(
    calls.map((call) => {
      const key = writeMutationKey(call.name, call.arguments, resolvePath, ctx.cwd);
      const run = () => executeSingleTool(call, registry, ctx, hooks, options, ts);
      return key ? mutationQueue.runExclusive(key, run) : run();
    }),
  );
}

export async function runLoop(
  ctx: AgentContext,
  hooks: HookRegistryImpl,
  options: RunLoopOptions,
): Promise<AgentContext> {
  const registry = toolMap(options.tools);
  const knownTools = new Set(options.tools.map((t) => t.name));
  let parseCorrectionRetries = 0;

  while (true) {
    const turnIndex = currentTurnCount(ctx.messages);
    const contextWindow = await getContextWindow(options.model);

    if (shouldCompact(ctx.messages, contextWindow)) {
      await hooks.fireHook("before_compact", { messages: ctx.messages }, ctx, options.signal);
      const cheapModel = options.cheapModel ?? defaultCheapModel();
      ctx.messages = await summariseOldTurns(ctx.messages, cheapModel);
    }
    ctx.messages = evictStaleToolResults(ctx.messages, turnIndex);

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

    const rawMessage = await options.provider(
      promptMessages,
      {
        model: options.model,
        system: options.system,
        tools: toProviderTools(options.tools),
        signal: options.signal,
        sessionId: options.sessionId,
      },
      (event) => {
        if (event.type === "text_delta") hooks.emit({ type: "text_delta", text: event.text });
        if (event.type === "reasoning_delta") {
          hooks.emit({ type: "reasoning_delta", text: event.text });
        }
      },
    );

    const { message, usedFallback } = enrichAssistantMessage(rawMessage, knownTools);
    const ts = () => new Date().toISOString();
    const toolCalls = message.content.filter((c): c is ToolCallBlock => c.type === "toolCall");
    const fromText = message.toolCallsFromText ?? usedFallback;

    if (
      fromText &&
      toolCalls.length > 0 &&
      parseCorrectionRetries < 2
    ) {
      const validationErrors = validateToolCalls(toolCalls, registry);
      if (validationErrors.length > 0) {
        ctx.messages.push(message);
        options.onEvent?.({ type: "assistant_chunk", ts: ts(), content: message.content });
        hooks.emit({ type: "assistant_message", message });
        ctx.messages.push({
          role: "user",
          content: [{ type: "text", text: formatToolValidationErrors(validationErrors) }],
        });
        options.onEvent?.({
          type: "user_message",
          ts: ts(),
          content: [{ type: "text", text: formatToolValidationErrors(validationErrors) }],
        });
        parseCorrectionRetries += 1;
        continue;
      }
    }

    parseCorrectionRetries = 0;
    ctx.messages.push(message);
    options.onEvent?.({ type: "assistant_chunk", ts: ts(), content: message.content });
    hooks.emit({ type: "assistant_message", message });

    if (toolCalls.length === 0) {
      hooks.emit({ type: "loop_end", reason: "complete" });
      break;
    }

    const results = await executeToolsParallel(toolCalls, registry, ctx, hooks, options, ts);

    for (const result of results) {
      ctx.messages.push(result.message);
      if (result.terminate) {
        hooks.emit({ type: "loop_end", reason: "terminate" });
        return ctx;
      }
    }
  }

  return ctx;
}

export function lastAssistantText(ctx: AgentContext): string {
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const m = ctx.messages[i];
    if (m.role !== "assistant") continue;
    return m.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}
