import type { ToolSet } from "ai";
import type { Message } from "../types.js";

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call_delta"; id: string; name: string; argumentsDelta: string }
  | { type: "done"; message: AssistantMessage };

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens: number;
}

export interface AssistantMessage extends Message {
  role: "assistant";
  model: string;
  usage?: Usage;
  stopReason?: string;
  /** Tool calls were recovered by parsing XML/JSON from assistant text. */
  toolCallsFromText?: boolean;
}

export interface StreamAssistantOptions {
  model: string;
  system?: string;
  tools?: ToolSet;
  signal?: AbortSignal;
  /** OpenRouter session id for sticky provider routing (prompt cache affinity). */
  sessionId?: string;
}

export interface StreamAssistantFn {
  (
    messages: Message[],
    options: StreamAssistantOptions,
    emit: (event: StreamEvent) => void,
  ): Promise<AssistantMessage>;
}

/** Model limits and metadata supplied by an LLM provider backend. */
export interface ModelMetadata {
  contextWindow: number;
}

/**
 * Provider capability for resolving model metadata (context window, etc.).
 * Each backend in the provider registry (issue #12) should implement this.
 */
export interface ModelMetadataProvider {
  readonly id: string;
  supportsModel(modelId: string): boolean;
  getContextWindow(modelId: string): Promise<number | undefined>;
}
