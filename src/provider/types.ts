import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import type { Message } from "../types.js";

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
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
  /** Model ids from the provider's live catalog (cached). Empty when unavailable. */
  listModelIds(): Promise<string[]>;
}

/** Named model slots resolved per provider (config override or bundled default). */
export type ModelSlot =
  | "main"
  | "explore"
  | "review"
  | "implement"
  | "delegate_read"
  | "compaction";

/** Bundled per-slot defaults when config has no override for that slot. */
export interface ProviderDefaultSlots {
  main: string;
  explore: string;
  delegate_read: string;
  compaction: string;
}

/** How a provider authenticates (API key from config). */
export type AuthStrategy = "api-key";

/** A user-editable config field persisted under `provider.<section>.<key>`.
 *  `section` defaults to the provider's `id` unless overridden by `configSection`.
 */
export interface ProviderConfigField {
  key: string;
  label: string;
  /** Mask input in the TUI when true (API keys, tokens). */
  secret?: boolean;
}

/**
 * An LLM backend the agent can resolve models from. Each provider owns its
 * credentials, base URL, model-id normalization, and model metadata. The
 * streaming/generation transport itself is shared (the Vercel AI SDK's
 * `streamText` / `generateText`), so a provider only needs to hand back an AI
 * SDK `LanguageModel` handle — it does not reimplement the transport.
 *
 * The registry (`src/provider/registry.ts`) maps `id` → implementation and
 * resolves the active provider from `loadConfig().provider.active`.
 */
export interface Provider {
  readonly id: string;
  readonly displayName: string;
  readonly authStrategy: AuthStrategy;
  /**
   * Config fields the TUI `/providers configure` command can collect and
   * persist to `~/.orin/config.json`.
   */
  readonly configFields?: readonly ProviderConfigField[];
  /**
   * Config section key under `provider.<section>` where this provider's fields
   * are stored. Defaults to the provider's `id`. Used when multiple providers
   * share credentials (e.g. opencode-go and opencode-zen both use `opencode`).
   */
  readonly configSection?: string;
  /** True when credentials are available in config. */
  isConfigured(): boolean;
  /** Map our internal model id to the provider-native id. */
  normalizeModelId(modelId: string): string;
  /** AI SDK language model handle for `streamText` / `generateText`. */
  languageModel(modelId: string): LanguageModel;
  /**
   * Provider-specific options for the shared `streamText` transport — e.g.
   * prompt-cache hints and session affinity. Optional: providers without such
   * options omit it. `stream.ts` calls this on the active provider.
   */
  streamProviderOptions?(
    modelId: string,
    sessionId?: string,
  ): SharedV3ProviderOptions | undefined;
  /**
   * Mark prompt-cache breakpoints on the converted AI SDK messages in place
   * (e.g. Anthropic-style `cache_control`). Optional no-op for providers
   * without explicit cache control.
   */
  markCacheBreakpoints?(aiMessages: ModelMessage[], modelId: string): void;
  /** Context-window / metadata lookups for this backend. */
  readonly metadata: ModelMetadataProvider;
  /**
   * Curated model ids shown in the `/model` picker when this provider is active.
   * Users can append extras via `models.providers.<id>.pickerExtras` in config.
   */
  readonly pickerModels: readonly string[];
  /** Bundled defaults when config has no override for a slot. Not stored in config. */
  readonly defaultSlots: ProviderDefaultSlots;
}
