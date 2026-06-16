import { getOpenRouter, getOpenRouterApiKey, resolveOpenRouterModelId } from "../openrouter-client.js";
import { lookupOpenRouterContextWindow } from "../openrouter-models.js";
import type { ModelMetadataProvider, Provider } from "../types.js";

const metadata: ModelMetadataProvider = {
  id: "openrouter",
  supportsModel(modelId) {
    return !modelId.startsWith("faux:");
  },
  getContextWindow(modelId) {
    return lookupOpenRouterContextWindow(modelId);
  },
};

/**
 * Default provider: routes models through OpenRouter using an API key. This is
 * the OpenRouter backend behind the provider abstraction — behaviour is
 * identical to the pre-registry direct `getOpenRouter()` call path.
 */
export const openRouterProvider: Provider = {
  id: "openrouter",
  displayName: "OpenRouter",
  authStrategy: "api-key",
  isConfigured() {
    return Boolean(getOpenRouterApiKey());
  },
  normalizeModelId(modelId) {
    return resolveOpenRouterModelId(modelId);
  },
  languageModel(modelId) {
    return getOpenRouter().chat(resolveOpenRouterModelId(modelId));
  },
  metadata,
};
