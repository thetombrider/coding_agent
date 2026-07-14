import {
  createOpenAiCompatibleProvider,
  lookupOpenAiCompatibleContextWindow,
  type OpenAiCompatibleProviderConfig,
} from "../openai-compatible.js";
import { lookupModelsDevContextWindow } from "../modelsdev.js";
import type { Provider } from "../types.js";

/** Curated OpenAI models for the `/model` picker (native ids, not OpenRouter slugs). */
export const OPENAI_PICKER_MODELS = [
  "gpt-5.6",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "o3",
  "o4-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4o",
] as const;

/**
 * Offline context-window fallback for curated picker models. Used when
 * models.dev is unreachable. Values mirror models.dev's `openai` provider
 * entry; the catalog is the source of truth when online.
 */
const OPENAI_OFFLINE_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-5.6": 1_050_000,
  "gpt-5.6-sol": 1_050_000,
  "gpt-5.6-terra": 1_050_000,
  "gpt-5.6-luna": 1_050_000,
  "gpt-5.5": 1_050_000,
  "gpt-5.5-pro": 1_050_000,
  "gpt-5.4": 1_050_000,
  "gpt-5.4-pro": 1_050_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.4-nano": 400_000,
  "o3": 200_000,
  "o4-mini": 200_000,
  "gpt-4.1": 1_047_576,
  "gpt-4.1-mini": 1_047_576,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
};

/** Strip `openai:` prefix and map legacy OpenRouter-style `openai/slug` ids. */
export function normalizeOpenAiModelId(modelId: string): string {
  let id = modelId.startsWith("openai:") ? modelId.slice("openai:".length) : modelId;
  if (id.startsWith("openai/")) {
    id = id.slice("openai/".length);
  }
  return id;
}

/**
 * OpenAI `-pro` models (`gpt-5-pro`, `gpt-5.4-pro`, `o3-pro`, …) are only served
 * by the Responses API and error on Chat Completions, so they must be routed to
 * `client.responses()`. Matches a `-pro` segment, including dated variants like
 * `gpt-5.4-pro-2026-03-05`.
 */
export function isOpenAiProModel(modelId: string): boolean {
  return /-pro(-|$)/.test(normalizeOpenAiModelId(modelId));
}

/**
 * Reasoning models (o-series, gpt-5 family except chat variants). Mirrors the
 * allowlist in `@ai-sdk/openai`'s `getOpenAILanguageModelCapabilities`.
 *
 * Chat Completions rejects function tools together with reasoning effort for
 * these models; the Responses API is the supported path for tool use and is
 * recommended by OpenAI for reasoning workloads generally.
 */
export function isOpenAiReasoningModel(modelId: string): boolean {
  const id = normalizeOpenAiModelId(modelId);
  if (id.startsWith("o1")) return true;
  if (id.startsWith("o3")) return true;
  if (id.startsWith("o4-mini")) return true;
  if (id.startsWith("gpt-5") && !id.startsWith("gpt-5-chat")) return true;
  return false;
}

/** Route models that must be served by `/v1/responses` instead of chat completions. */
export function shouldUseOpenAiResponsesApi(modelId: string): boolean {
  return isOpenAiProModel(modelId) || isOpenAiReasoningModel(modelId);
}

const openaiCompatibleCfg: OpenAiCompatibleProviderConfig = {
  id: "openai",
  displayName: "OpenAI",
  configSection: "openai",
  idPrefix: "openai:",
  modelsListUrl: "https://api.openai.com/v1/models",
  pickerModels: OPENAI_PICKER_MODELS,
  defaultSlots: {
    main: "gpt-5.6",
    explore: "gpt-5.6-terra",
    delegate_read: "gpt-5.6-terra",
    compaction: "gpt-5.6-terra",
  },
  // Reasoning and `-pro` models must use the Responses API — Chat Completions
  // rejects function tools with reasoning effort (see issues #321, #394).
  responsesApiModel: shouldUseOpenAiResponsesApi,
  // OpenAI's /v1/models lists ids only — no context_length. Source windows from
  // models.dev (same catalog opencode uses), then offline picker defaults, then
  // any context fields the live catalog happens to publish.
  getContextWindow: async (modelId, fetchImpl) => {
    const normalized = normalizeOpenAiModelId(modelId);
    return (await lookupModelsDevContextWindow("openai", normalized, fetchImpl))
      ?? OPENAI_OFFLINE_CONTEXT_WINDOWS[normalized]
      ?? lookupOpenAiCompatibleContextWindow(openaiCompatibleCfg, normalized, fetchImpl);
  },
};

const base = createOpenAiCompatibleProvider(openaiCompatibleCfg);

/** Native OpenAI Platform backend — default `api.openai.com` via `@ai-sdk/openai`. */
export const openaiProvider: Provider = {
  ...base,
  normalizeModelId: normalizeOpenAiModelId,
  languageModel(modelId) {
    return base.languageModel(normalizeOpenAiModelId(modelId));
  },
  metadata: {
    ...base.metadata,
    supportsModel(modelId) {
      if (modelId.startsWith("faux:")) return false;
      const normalized = normalizeOpenAiModelId(modelId);
      return !normalized.includes("/");
    },
    getContextWindow(modelId) {
      return base.metadata.getContextWindow(normalizeOpenAiModelId(modelId));
    },
  },
};
