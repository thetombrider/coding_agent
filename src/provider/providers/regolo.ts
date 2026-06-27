import { createOpenAiCompatibleProvider } from "../openai-compatible.js";

/** Curated Regolo models for the `/model` picker (native ids, not OpenRouter slugs). */
export const REGOLO_PICKER_MODELS = [
  "Llama-3.3-70B-Instruct",
  "qwen3-coder-next",
  "qwen3.5-122b",
  "qwen3.6-27b",
  "gpt-oss-120b",
  "mistral-small-4-119b",
  "gemma4-31b",
] as const;

/** Regolo AI — EU-hosted OpenAI-compatible inference (https://regolo.ai). */
export const regoloProvider = createOpenAiCompatibleProvider({
  id: "regolo",
  displayName: "Regolo AI",
  configSection: "regolo",
  baseURL: "https://api.regolo.ai/v1",
  idPrefix: "regolo:",
  pickerModels: REGOLO_PICKER_MODELS,
  defaultSlots: {
    main: "Llama-3.3-70B-Instruct",
    explore: "qwen3.5-9b",
    delegate_read: "qwen3.5-9b",
    compaction: "qwen3.5-9b",
  },
});
