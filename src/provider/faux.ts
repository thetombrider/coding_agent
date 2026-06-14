import type { Message } from "../types.js";
import type { AssistantMessage, StreamAssistantFn } from "./types.js";

export interface FauxScript {
  /** Text chunks emitted in order before optional tool calls. */
  text?: string[];
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: unknown;
  }>;
  model?: string;
}

export function createFauxProvider(script: FauxScript): StreamAssistantFn {
  return async (_messages, options, emit) => {
    const model = script.model ?? options.model;
    const content: AssistantMessage["content"] = [];

    for (const chunk of script.text ?? []) {
      emit({ type: "text_delta", text: chunk });
      const last = content.at(-1);
      if (last?.type === "text") {
        last.text += chunk;
      } else {
        content.push({ type: "text", text: chunk });
      }
    }

    for (const tc of script.toolCalls ?? []) {
      const argsJson = JSON.stringify(tc.arguments);
      emit({
        type: "tool_call_delta",
        id: tc.id,
        name: tc.name,
        argumentsDelta: argsJson,
      });
      content.push({
        type: "toolCall",
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      });
    }

    const message: AssistantMessage = {
      role: "assistant",
      content,
      model,
      usage: { input: 0, output: 0, totalTokens: 0 },
      stopReason: (script.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "stop",
    };

    emit({ type: "done", message });
    return message;
  };
}

export function createStatefulFauxProvider(scripts: FauxScript[]): StreamAssistantFn {
  let turn = 0;
  return (messages, options, emit) => {
    const script = scripts[Math.min(turn, scripts.length - 1)]!;
    turn += 1;
    return createFauxProvider({
      ...script,
      model: script.model ?? options.model,
    })(messages, options, emit);
  };
}

export function fauxOneShot(text: string, model = "faux:test"): StreamAssistantFn {
  const chunks = text.match(/.{1,4}/gs) ?? [text];
  return createFauxProvider({ text: chunks, model });
}

export async function runOneShot(
  provider: StreamAssistantFn,
  prompt: string,
  options: { model: string; system?: string },
  onText: (chunk: string) => void,
): Promise<AssistantMessage> {
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: prompt }] }];
  return provider(messages, options, (event) => {
    if (event.type === "text_delta") onText(event.text);
  });
}
