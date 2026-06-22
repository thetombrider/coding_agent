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

function toolCallNames(messages: Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const block of m.content) {
      if (block.type === "toolCall") names.set(block.id, block.name);
    }
  }
  return names;
}

export function toAiMessages(messages: Message[]): ModelMessage[] {
  const callNames = toolCallNames(messages);
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
            toolName: callNames.get(c.toolCallId) ?? "unknown",
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
    { id: string; name: string; arguments: string }
  >();

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
          const entry = {
            id: part.toolCallId,
            name: part.toolName,
            arguments: JSON.stringify(part.input),
          };
          toolCalls.set(part.toolCallId, entry);
          emit({
            type: "tool_call_delta",
            id: part.toolCallId,
            name: part.toolName,
            argumentsDelta: entry.arguments,
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

    for (const tc of toolCalls.values()) {
      content.push({
        type: "toolCall",
        id: tc.id,
        name: tc.name,
        arguments: JSON.parse(tc.arguments),
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
