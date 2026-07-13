import { createOpenAiCompatibleProvider } from "../openai-compatible.js";
import { lookupModelsDevContextWindow } from "../modelsdev.js";

/** Curated Vercel AI Gateway models for the `/model` picker. */
export const VERCEL_PICKER_MODELS = [
  "anthropic/claude-sonnet-4.6",
  "openai/gpt-5.5",
  "openai/gpt-5.4-mini",
  "google/gemini-3.5-flash",
  "xai/grok-4.3",
] as const;

/**
 * Vercel AI Gateway — OpenAI-compatible gateway for multiple model providers.
 * https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions
 */
export const vercelProvider = createOpenAiCompatibleProvider({
  id: "vercel",
  displayName: "Vercel AI Gateway",
  configSection: "vercel",
  baseURL: "https://ai-gateway.vercel.sh/v1",
  idPrefix: "vercel:",
  pickerModels: VERCEL_PICKER_MODELS,
  defaultSlots: {
    main: "anthropic/claude-sonnet-4.6",
    explore: "openai/gpt-5.4-mini",
    delegate_read: "openai/gpt-5.4-mini",
    compaction: "openai/gpt-5.4-mini",
  },
  // Vercel's /v1/models endpoint omits context windows. Source them from
  // models.dev instead — the `vercel` provider entry uses provider/model ids.
  getContextWindow: (modelId) => lookupModelsDevContextWindow("vercel", modelId),
});
