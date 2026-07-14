import { streamText, type ModelMessage, type ToolSet } from "ai";
import { formatStreamError } from "./format-stream-error.js";
import { resolveActiveProvider } from "./registry.js";
import { enrichAssistantMessage } from "./tool-call-parser.js";
import type { Message } from "../types.js";
import type {
  AssistantMessage,
  StreamAssistantFn,
  StreamEvent,
} from "./types.js";

export function toAiMessages(messages: Message[]): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (const m of messages) {
    if (m.role === "tool") {
      result.push({
        role: "tool",
        content: m.content
          .filter((c) => c.type === "toolResult")
          .map((c) => ({
            type: "tool-result" as const,
            toolCallId: c.toolCallId,
            // toolName is required on the type; the cast guards against legacy
            // persisted data that predates the field (JSON has no type checks).
            toolName: (c.toolName as string | undefined) ?? "unknown",
            output: { type: "text" as const, value: c.output },
          })),
      });
      continue;
    }

    if (m.role === "assistant") {
      const parts: Array<
        | { type: "text"; text: string }
        | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
      > = [];
      for (const block of m.content) {
        if (block.type === "text") parts.push({ type: "text", text: block.text });
        if (block.type === "toolCall") {
          parts.push({
            type: "tool-call",
            toolCallId: block.id,
            toolName: block.name,
            input: block.arguments,
          });
        }
      }
      result.push({ role: "assistant", content: parts });
      continue;
    }

    const text = m.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    result.push({ role: m.role, content: text });
  }

  return result;
}

/** Normalize provider tool input to a plain object; never throws. */
export function normalizeToolInput(
  input: unknown,
): { value: unknown; error?: string } {
  if (input === undefined || input === null) {
    return { value: {}, error: "missing tool arguments" };
  }
  if (typeof input === "string") {
    try {
      return { value: JSON.parse(input) };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { value: {}, error: `invalid JSON: ${detail}` };
    }
  }
  return { value: input };
}

function safeStringifyToolInput(input: unknown): string {
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
}

export const streamAssistant: StreamAssistantFn = async (
  messages,
  options,
  emit,
) => {
  const provider = resolveActiveProvider();
  const content: AssistantMessage["content"] = [];
  let textBuffer = "";
  let reasoningBuffer = "";
  const toolCalls = new Map<
    string,
    { id: string; name: string; input: unknown; parseError?: string }
  >();
  const toolInputProgress = new Map<string, { name: string; chars: number }>();

  const aiMessages = toAiMessages(messages);
  provider.markCacheBreakpoints?.(aiMessages, options.model);
  try {
    const result = streamText({
      model: provider.languageModel(options.model),
      system: options.system,
      messages: aiMessages,
      tools: options.tools ?? ({} as ToolSet),
      abortSignal: options.signal,
      providerOptions: provider.streamProviderOptions?.(options.model, options.sessionId),
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "error": {
          throw part.error;
        }
        case "text-delta": {
          textBuffer += part.text;
          emit({ type: "text_delta", text: part.text });
          break;
        }
        case "reasoning-delta": {
          reasoningBuffer += part.text;
          emit({ type: "reasoning_delta", text: part.text });
          break;
        }
        case "tool-call": {
          const { value, error } = normalizeToolInput(part.input);
          const entry = {
            id: part.toolCallId,
            name: part.toolName,
            input: value,
            parseError: error,
          };
          toolCalls.set(part.toolCallId, entry);
          emit({
            type: "tool_call_delta",
            id: part.toolCallId,
            name: part.toolName,
            argumentsDelta: safeStringifyToolInput(value),
          });
          break;
        }
        case "tool-input-start": {
          toolInputProgress.set(part.id, { name: part.toolName, chars: 0 });
          emit({ type: "tool_input_start", id: part.id, name: part.toolName });
          break;
        }
        case "tool-input-delta": {
          const progress = toolInputProgress.get(part.id);
          if (!progress) break;
          progress.chars += part.delta.length;
          emit({
            type: "tool_input_delta",
            id: part.id,
            name: progress.name,
            chars: progress.chars,
          });
          break;
        }
        default:
          break;
      }
    }

    if (reasoningBuffer) {
      content.push({ type: "reasoning", text: reasoningBuffer });
    }

    if (textBuffer) {
      content.push({ type: "text", text: textBuffer });
    }

    const parseFailures: string[] = [];
    for (const tc of toolCalls.values()) {
      if (tc.parseError) {
        parseFailures.push(`"${tc.name}" (${tc.id}): ${tc.parseError}`);
      }
      content.push({
        type: "toolCall",
        id: tc.id,
        name: tc.name,
        arguments: tc.input,
      });
    }
    if (parseFailures.length > 0) {
      content.push({
        type: "text",
        text:
          "Some tool calls had malformed arguments and could not be parsed. "
          + parseFailures.join("; ")
          + ". The tools will receive validation errors so the model can retry.",
      });
    }

    const usage = await result.usage;
    const finishReason = await result.finishReason;

    const message: AssistantMessage = {
      role: "assistant",
      content,
      model: options.model,
      usage: usage
        ? {
            input: usage.inputTokens ?? 0,
            output: usage.outputTokens ?? 0,
            cacheRead: usage.inputTokenDetails?.cacheReadTokens,
            cacheWrite: usage.inputTokenDetails?.cacheWriteTokens,
            totalTokens:
              usage.totalTokens ??
              (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
          }
        : undefined,
      stopReason: finishReason ?? undefined,
    };

    const knownTools = options.tools ? new Set(Object.keys(options.tools)) : undefined;
    const { message: enriched } = enrichAssistantMessage(message, knownTools);

    emit({ type: "done", message: enriched });
    return enriched;
  } catch (err) {
    throw new Error(
      formatStreamError(err),
      { cause: err },
    );
  }
};

export function collectStreamEvents(
  fn: StreamAssistantFn,
  messages: Message[],
  options: Parameters<StreamAssistantFn>[1],
): Promise<{ events: StreamEvent[]; message: AssistantMessage }> {
  const events: StreamEvent[] = [];
  return fn(messages, options, (e) => events.push(e)).then((message) => ({
    events,
    message,
  }));
}
