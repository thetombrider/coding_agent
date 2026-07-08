import { createOpenAiCompatibleProvider } from "../openai-compatible.js";
import { lookupModelsDevContextWindow } from "../modelsdev.js";

/** Curated Cerebras models for the `/model` picker (native ids). */
export const CEREBRAS_PICKER_MODELS = [
  "zai-glm-4.7",
  "gpt-oss-120b",
  "gemma-4-31b",
] as const;

/**
 * Cerebras Inference — fast OpenAI-compatible inference
 * (https://inference.cerebras.ai). Backed by Cerebras's Wafer-Scale Engines.
 */
export const cerebrasProvider = createOpenAiCompatibleProvider({
  id: "cerebras",
  displayName: "Cerebras",
  configSection: "cerebras",
  baseURL: "https://api.cerebras.ai/v1",
  idPrefix: "cerebras:",
  pickerModels: CEREBRAS_PICKER_MODELS,
  defaultSlots: {
    main: "zai-glm-4.7",
    explore: "gemma-4-31b",
    delegate_read: "gemma-4-31b",
    compaction: "gemma-4-31b",
  },
  // Cerebras's /v1/models endpoint omits context windows. Source them from
  // models.dev instead — the cerebras provider entry there uses lowercase
  // model ids, so the helper's case-insensitive lookup handles our picker ids.
  getContextWindow: (modelId) => lookupModelsDevContextWindow("cerebras", modelId),
});