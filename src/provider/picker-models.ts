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

/**
 * Whether a curated id is present in the live catalog. Matches exact ids as well
 * as dated snapshots — e.g. curated `claude-haiku-4-5` matches the published
 * `claude-haiku-4-5-20251001` — so alias ids survive catalog filtering.
 */
function catalogContains(catalogIds: Iterable<string>, normalized: string, original: string): boolean {
  for (const id of catalogIds) {
    if (id === normalized || id === original) return true;
    if (id.startsWith(`${normalized}-`) || id.startsWith(`${original}-`)) return true;
  }
  return false;
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
    return catalogContains(ids, normalized, modelId);
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
    const validated = curated.filter((id) =>
      catalogContains(catalogIds, provider.normalizeModelId(id), id),
    );
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
