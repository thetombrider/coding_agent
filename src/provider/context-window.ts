import { loadConfig } from "../config/config.js";
import { lookupOpenRouterContextWindow } from "./openrouter-models.js";
import { resolveOpenRouterModelId } from "./openrouter.js";
import type { ModelMetadataProvider } from "./types.js";

export const DEFAULT_CONTEXT_WINDOW = 32000;

const openRouterMetadataProvider: ModelMetadataProvider = {
  id: "openrouter",
  supportsModel(modelId) {
    return !modelId.startsWith("faux:");
  },
  getContextWindow(modelId) {
    return lookupOpenRouterContextWindow(modelId);
  },
};

/** Registered metadata providers. Issue #12 registry will own this list. */
export const MODEL_METADATA_PROVIDERS: ModelMetadataProvider[] = [
  openRouterMetadataProvider,
];

function configContextWindow(modelId: string): number | undefined {
  const cfg = loadConfig().models.contextWindows;
  return cfg[modelId] ?? cfg[resolveOpenRouterModelId(modelId)];
}

function resolveMetadataProvider(modelId: string): ModelMetadataProvider | undefined {
  const active = loadConfig().provider.active;
  const activeProvider = MODEL_METADATA_PROVIDERS.find(
    (provider) => provider.id === active && provider.supportsModel(modelId),
  );
  if (activeProvider) return activeProvider;
  return MODEL_METADATA_PROVIDERS.find((provider) => provider.supportsModel(modelId));
}

/**
 * Resolve a model's context window: provider catalog first, then config, then default.
 * New LLM backends added in issue #12 must register a ModelMetadataProvider here.
 */
export async function getContextWindow(modelId: string): Promise<number> {
  const provider = resolveMetadataProvider(modelId);
  if (provider) {
    try {
      const fromProvider = await provider.getContextWindow(modelId);
      if (fromProvider !== undefined) return fromProvider;
    } catch {
      // Fall back to config when the provider catalog is unreachable.
    }
  }

  return configContextWindow(modelId) ?? DEFAULT_CONTEXT_WINDOW;
}
