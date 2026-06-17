import { loadConfig } from "../config/config.js";
import {
  activeProviderId,
  getProvider,
  resolveActiveProvider,
  resolvePickerModels,
} from "./registry.js";
import type { Provider } from "./types.js";

/** Fast sync check — good enough for provider switches before catalog loads. */
export function modelLikelySupported(provider: Provider, modelId: string): boolean {
  return provider.metadata.supportsModel(modelId);
}

/** Validate a model id against the provider's live catalog when configured. */
export async function modelSupportedByCatalog(
  provider: Provider,
  modelId: string,
): Promise<boolean> {
  if (!provider.isConfigured()) return modelLikelySupported(provider, modelId);
  try {
    const ids = await provider.metadata.listModelIds();
    if (ids.length === 0) return modelLikelySupported(provider, modelId);
    const normalized = provider.normalizeModelId(modelId);
    return ids.includes(normalized) || ids.includes(modelId);
  } catch {
    return modelLikelySupported(provider, modelId);
  }
}

/**
 * Curated picker models, filtered to ids present in the live catalog when the
 * provider is configured and the catalog is reachable.
 */
export async function loadPickerModels(providerId?: string): Promise<string[]> {
  const provider = getProvider(providerId ?? activeProviderId()) ?? resolveActiveProvider();
  const curated = [...resolvePickerModels(provider.id)];

  if (!provider.isConfigured()) return curated;

  try {
    const catalogIds = await provider.metadata.listModelIds();
    if (catalogIds.length === 0) return curated;
    const catalogSet = new Set(catalogIds);
    const validated = curated.filter((id) => {
      const normalized = provider.normalizeModelId(id);
      return catalogSet.has(normalized) || catalogSet.has(id);
    });
    return validated.length > 0 ? validated : curated;
  } catch {
    return curated;
  }
}

/**
 * Pick a model when switching providers: keep the current model when compatible,
 * otherwise restore last-used for the target, then fall back to bundled defaults.
 */
export function resolveModelOnProviderSwitch(
  _fromProviderId: string,
  toProviderId: string,
  currentModel: string,
): { model?: string; note: string } {
  const target = getProvider(toProviderId);
  if (!target) return { note: "" };

  const cfg = loadConfig();
  const lastUsed = cfg.models.lastUsed ?? {};

  if (modelLikelySupported(target, currentModel)) {
    return { note: "" };
  }

  const restored = lastUsed[toProviderId]?.main;
  if (restored && modelLikelySupported(target, restored)) {
    return { model: restored, note: ` · model → ${restored}` };
  }

  const fallback = target.defaultModels.main;
  return { model: fallback, note: ` · model → ${fallback}` };
}

/** Persist the current model under the outgoing provider before switching away. */
export function lastUsedPatchForProviderSwitch(
  fromProviderId: string,
  currentModel: string,
  currentCheap?: string,
): Record<string, { main: string; cheap?: string }> {
  return {
    [fromProviderId]: {
      main: currentModel,
      ...(currentCheap ? { cheap: currentCheap } : {}),
    },
  };
}
