import {
  createOpenAiCompatibleProvider,
  lookupOpenAiCompatibleContextWindow,
  type OpenAiCompatibleProviderConfig,
} from "../openai-compatible.js";
import { lookupModelsDevContextWindow } from "../modelsdev.js";
import type { Provider } from "../types.js";

/** Curated OpenAI models for the `/model` picker (native ids, not OpenRouter slugs). */
export const OPENAI_PICKER_MODELS = [
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

const openaiCompatibleCfg: OpenAiCompatibleProviderConfig = {
  id: "openai",
  displayName: "OpenAI",
  configSection: "openai",
  idPrefix: "openai:",
  modelsListUrl: "https://api.openai.com/v1/models",
  pickerModels: OPENAI_PICKER_MODELS,
  defaultSlots: {
    main: "gpt-5.5",
    explore: "gpt-5.4-mini",
    delegate_read: "gpt-5.4-mini",
    compaction: "gpt-5.4-mini",
  },
  // `-pro` models are only available on the Responses API; route them there
  // instead of Chat Completions (see issue #321).
  responsesApiModel: isOpenAiProModel,
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
