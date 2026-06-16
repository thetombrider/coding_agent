import { loadConfig } from "../config/config.js";
import { activeProviderId, metadataProviders, resolveActiveProvider } from "./registry.js";
import type { ModelMetadataProvider } from "./types.js";

export const DEFAULT_CONTEXT_WINDOW = 32000;

/**
 * Metadata providers registered with the provider registry (issue #12). This
 * is a snapshot for inspection; the resolution below queries the registry live
 * so providers registered after import are still considered.
 */
export const MODEL_METADATA_PROVIDERS: ModelMetadataProvider[] = metadataProviders();

function configContextWindow(modelId: string): number | undefined {
  const cfg = loadConfig().models.contextWindows;
  return cfg[modelId] ?? cfg[resolveActiveProvider().normalizeModelId(modelId)];
}

function resolveMetadataProvider(modelId: string): ModelMetadataProvider | undefined {
  const active = activeProviderId();
  const providers = metadataProviders();
  const activeProvider = providers.find(
    (provider) => provider.id === active && provider.supportsModel(modelId),
  );
  if (activeProvider) return activeProvider;
  return providers.find((provider) => provider.supportsModel(modelId));
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
