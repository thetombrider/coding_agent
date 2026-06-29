import { createOpenAiCompatibleProvider } from "../openai-compatible.js";
import type { Provider } from "../types.js";

/** Curated OpenAI models for the `/model` picker (native ids, not OpenRouter slugs). */
export const OPENAI_PICKER_MODELS = [
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4o",
  "gpt-4o-mini",
  "o3-mini",
] as const;

const base = createOpenAiCompatibleProvider({
  id: "openai",
  displayName: "OpenAI",
  configSection: "openai",
  idPrefix: "openai:",
  modelsListUrl: "https://api.openai.com/v1/models",
  pickerModels: OPENAI_PICKER_MODELS,
  defaultSlots: {
    main: "gpt-4.1",
    explore: "gpt-4.1-mini",
    delegate_read: "gpt-4.1-mini",
    compaction: "gpt-4.1-mini",
  },
});

/** Strip `openai:` prefix and map legacy OpenRouter-style `openai/slug` ids. */
export function normalizeOpenAiModelId(modelId: string): string {
  let id = base.normalizeModelId(modelId);
  if (id.startsWith("openai/")) {
    id = id.slice("openai/".length);
  }
  return id;
}

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
