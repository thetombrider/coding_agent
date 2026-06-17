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
  envVar: "REGOLO_API_KEY",
  configSection: "regolo",
  baseURL: "https://api.regolo.ai/v1",
  idPrefix: "regolo:",
  pickerModels: REGOLO_PICKER_MODELS,
  defaultModels: {
    main: "Llama-3.3-70B-Instruct",
    cheap: "qwen3.5-9b",
  },
});
