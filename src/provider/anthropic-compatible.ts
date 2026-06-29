/**
 * Shared factory for Anthropic Messages-API backends. The native Anthropic
 * provider and OpenCode's `/messages` models are thin wrappers around this
 * helper — the Messages-API counterpart to `openai-compatible.ts`.
 *
 * A custom `baseURL` points the same `@ai-sdk/anthropic` client at an
 * Anthropic-compatible gateway (e.g. `https://opencode.ai/zen/go/v1`, which the
 * SDK turns into `…/v1/messages`). Model metadata is supplied by the caller so
 * each backend keeps its own catalog source (the native Anthropic models API
 * vs. an OpenAI-style `/models` endpoint).
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { loadConfig, type Config } from "../config/config.js";
import type { ModelMetadataProvider, Provider, ProviderDefaultSlots } from "./types.js";

export interface AnthropicCompatibleProviderConfig {
  id: string;
  displayName: string;
  configSection: keyof Pick<Config["provider"], "anthropic" | "opencode">;
  /** Custom Messages-API base URL; omit for the native Anthropic API. */
  baseURL?: string;
  /** Strip this prefix from model ids (e.g. `anthropic:`). */
  idPrefix?: string;
  /** Map legacy / aliased ids to provider-native ids. */
  modelAliases?: Record<string, string>;
  /** Apply Anthropic prompt-cache breakpoints / `cache_control`. Default: true. */
  promptCaching?: boolean;
  /** Restrict prompt caching to ids this returns true for (already normalized). Default: all. */
  supportsPromptCaching?: (normalizedId: string) => boolean;
  /** Override the API-key config-field label. Defaults to `${displayName} API key`. */
  apiKeyLabel?: string;
  metadata: ModelMetadataProvider;
  pickerModels: readonly string[];
  defaultSlots: ProviderDefaultSlots;
}

const EPHEMERAL_CACHE = { type: "ephemeral" as const };

export function anthropicPromptCacheProviderOptions(): SharedV3ProviderOptions {
  return { anthropic: { cacheControl: EPHEMERAL_CACHE } };
}

/** Mark the stable conversation prefix for caching (penultimate converted message). */
export function markAnthropicCacheBreakpoints(aiMessages: ModelMessage[]): void {
  if (aiMessages.length < 2) return;
  const target = aiMessages[aiMessages.length - 2]!;
  target.providerOptions = {
    ...target.providerOptions,
    ...anthropicPromptCacheProviderOptions(),
  };
}

/** Strip an optional id prefix, then apply alias mapping. */
export function normalizeAnthropicModelId(
  modelId: string,
  idPrefix?: string,
  aliases?: Record<string, string>,
): string {
  const id = idPrefix && modelId.startsWith(idPrefix) ? modelId.slice(idPrefix.length) : modelId;
  return aliases?.[id] ?? id;
}

function getApiKey(
  configSection: AnthropicCompatibleProviderConfig["configSection"],
): string | undefined {
  const section = loadConfig().provider[configSection];
  const apiKey = section && typeof section === "object" && "apiKey" in section
    ? (section as { apiKey?: string }).apiKey?.trim()
    : undefined;
  return apiKey || undefined;
}

/**
 * Factory for Anthropic Messages-API provider backends. The native Anthropic
 * provider and OpenCode's `/messages` models are thin wrappers around this.
 */
export function createAnthropicCompatibleProvider(cfg: AnthropicCompatibleProviderConfig): Provider {
  const promptCaching = cfg.promptCaching ?? true;
  const supportsCaching = cfg.supportsPromptCaching ?? (() => true);

  function resolveApiKey(): string | undefined {
    return getApiKey(cfg.configSection);
  }

  function normalize(modelId: string): string {
    return normalizeAnthropicModelId(modelId, cfg.idPrefix, cfg.modelAliases);
  }

  function getClient() {
    const apiKey = resolveApiKey();
    if (!apiKey) {
      throw new Error(
        `${cfg.displayName} is not configured — set provider.${cfg.id}.apiKey in ~/.orin/config.json `
        + `or run /providers configure ${cfg.id}`,
      );
    }
    return createAnthropic({
      apiKey,
      ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    });
  }

  function cachingEnabledFor(modelId: string): boolean {
    return promptCaching && supportsCaching(normalize(modelId));
  }

  return {
    id: cfg.id,
    displayName: cfg.displayName,
    authStrategy: "api-key",
    configFields: [
      {
        key: "apiKey",
        label: cfg.apiKeyLabel ?? `${cfg.displayName} API key`,
        secret: true,
      },
    ],
    isConfigured() {
      return Boolean(resolveApiKey());
    },
    normalizeModelId(modelId) {
      return normalize(modelId);
    },
    languageModel(modelId) {
      return getClient().languageModel(normalize(modelId));
    },
    streamProviderOptions(modelId) {
      return cachingEnabledFor(modelId) ? anthropicPromptCacheProviderOptions() : undefined;
    },
    markCacheBreakpoints(aiMessages, modelId) {
      if (cachingEnabledFor(modelId)) markAnthropicCacheBreakpoints(aiMessages);
    },
    configSection: cfg.configSection,
    metadata: cfg.metadata,
    pickerModels: cfg.pickerModels,
    defaultSlots: cfg.defaultSlots,
  };
}
