import { getOpenRouterApiKey, resolveOpenRouterModelId } from "./openrouter-client.js";

const OPENROUTER_MODEL_URL = "https://openrouter.ai/api/v1/model";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const LOOKUP_TTL_MS = 60 * 60 * 1000;
const CATALOG_TTL_MS = 60 * 60 * 1000;

const VARIANT_SUFFIXES = [":nitro", ":floor", ":extended", ":thinking", ":free"] as const;

interface OpenRouterModelRecord {
  id: string;
  canonical_slug?: string;
  context_length: number | null;
  top_provider?: { context_length: number | null };
}

interface OpenRouterModelResponse {
  data: OpenRouterModelRecord;
}

interface OpenRouterModelsResponse {
  data: OpenRouterModelRecord[];
}

export type FetchModelsCatalog = typeof fetch;

let lookupCache = new Map<string, { value: number | undefined; fetchedAt: number }>();
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

/** Build GET /api/v1/model/{author}/{slug} per OpenRouter docs. */
export function openRouterModelLookupUrl(modelId: string): string | undefined {
  const normalized = resolveOpenRouterModelId(modelId);
  const slash = normalized.indexOf("/");
  if (slash <= 0 || slash === normalized.length - 1) return undefined;
  const author = normalized.slice(0, slash);
  const slug = normalized.slice(slash + 1);
  return `${OPENROUTER_MODEL_URL}/${author}/${slug}`;
}

function openRouterRequestInit(apiKey?: string): RequestInit {
  const key = apiKey ?? getOpenRouterApiKey();
  if (!key) return {};
  return { headers: { Authorization: `Bearer ${key}` } };
}

/** @internal test helper */
export function resetOpenRouterModelsCache(): void {
  lookupCache.clear();
  catalogCache = null;
  catalogFetchedAt = 0;
}

async function fetchSingleModelContextWindow(
  modelId: string,
  fetchImpl: FetchModelsCatalog,
  apiKey?: string,
): Promise<number | undefined> {
  const url = openRouterModelLookupUrl(modelId);
  if (!url) return undefined;

  const response = await fetchImpl(url, openRouterRequestInit(apiKey));
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`OpenRouter model API failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as OpenRouterModelResponse;
  return resolveContextLength(body.data);
}

export async function loadOpenRouterModelsCatalog(
  fetchImpl: FetchModelsCatalog = fetch,
  apiKey?: string,
): Promise<Map<string, number>> {
  if (catalogCache && Date.now() - catalogFetchedAt < CATALOG_TTL_MS) {
    return catalogCache;
  }

  const response = await fetchImpl(OPENROUTER_MODELS_URL, openRouterRequestInit(apiKey));
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

/**
 * Resolve context window via OpenRouter model metadata.
 * Tries GET /api/v1/model/{author}/{slug} first, then the full catalog.
 */
export async function lookupOpenRouterContextWindow(
  modelId: string,
  fetchImpl: FetchModelsCatalog = fetch,
  apiKey?: string,
): Promise<number | undefined> {
  for (const key of lookupKeys(modelId)) {
    const cached = lookupCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < LOOKUP_TTL_MS) {
      if (cached.value !== undefined) return cached.value;
      continue;
    }

    try {
      const fromSingle = await fetchSingleModelContextWindow(key, fetchImpl, apiKey);
      lookupCache.set(key, { value: fromSingle, fetchedAt: Date.now() });
      if (fromSingle !== undefined) return fromSingle;
    } catch {
      // Fall through to catalog on transient single-model errors.
    }
  }

  const catalog = await loadOpenRouterModelsCatalog(fetchImpl, apiKey);
  for (const key of lookupKeys(modelId)) {
    const match = catalog.get(key);
    if (match !== undefined) {
      lookupCache.set(key, { value: match, fetchedAt: Date.now() });
      return match;
    }
  }

  return undefined;
}
