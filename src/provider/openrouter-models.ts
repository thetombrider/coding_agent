import { resolveOpenRouterModelId } from "./openrouter.js";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CATALOG_TTL_MS = 60 * 60 * 1000;

const VARIANT_SUFFIXES = [":nitro", ":floor", ":extended", ":thinking", ":free"] as const;

interface OpenRouterModelRecord {
  id: string;
  canonical_slug?: string;
  context_length: number | null;
  top_provider?: { context_length: number | null };
}

interface OpenRouterModelsResponse {
  data: OpenRouterModelRecord[];
}

export type FetchModelsCatalog = typeof fetch;

let catalogCache: Map<string, number> | null = null;
let catalogFetchedAt = 0;

function resolveContextLength(model: OpenRouterModelRecord): number | undefined {
  const fromTop = model.top_provider?.context_length;
  if (typeof fromTop === "number" && fromTop > 0) return fromTop;
  if (typeof model.context_length === "number" && model.context_length > 0) {
    return model.context_length;
  }
  return undefined;
}

function lookupKeys(modelId: string): string[] {
  const normalized = resolveOpenRouterModelId(modelId);
  const keys = [normalized];
  for (const suffix of VARIANT_SUFFIXES) {
    if (normalized.endsWith(suffix)) keys.push(normalized.slice(0, -suffix.length));
  }
  return [...new Set(keys)];
}

/** @internal test helper */
export function resetOpenRouterModelsCache(): void {
  catalogCache = null;
  catalogFetchedAt = 0;
}

export async function loadOpenRouterModelsCatalog(
  fetchImpl: FetchModelsCatalog = fetch,
): Promise<Map<string, number>> {
  if (catalogCache && Date.now() - catalogFetchedAt < CATALOG_TTL_MS) {
    return catalogCache;
  }

  const response = await fetchImpl(OPENROUTER_MODELS_URL);
  if (!response.ok) {
    throw new Error(`OpenRouter models API failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as OpenRouterModelsResponse;
  const next = new Map<string, number>();

  for (const model of body.data) {
    const contextWindow = resolveContextLength(model);
    if (contextWindow === undefined) continue;
    next.set(model.id, contextWindow);
    if (model.canonical_slug) next.set(model.canonical_slug, contextWindow);
  }

  catalogCache = next;
  catalogFetchedAt = Date.now();
  return next;
}

export async function lookupOpenRouterContextWindow(
  modelId: string,
  fetchImpl: FetchModelsCatalog = fetch,
): Promise<number | undefined> {
  const catalog = await loadOpenRouterModelsCatalog(fetchImpl);
  for (const key of lookupKeys(modelId)) {
    const match = catalog.get(key);
    if (match !== undefined) return match;
  }
  return undefined;
}
