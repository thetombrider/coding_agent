/**
 * models.dev-backed context-window lookup.
 *
 * Opencode's `/v1/models` endpoint, regolo's, and most other gateway
 * `/v1/models` responses only return `{id, object, created, owned_by}` —
 * no `context_length` field — and the per-provider docs pages rarely
 * publish per-model context windows in a parseable form. We instead
 * consult https://models.dev/api.json, a public, unauthenticated, CORS-
 * enabled catalog curated by the opencode team (146 providers, 5,255
 * models, MIT-licensed, hourly sync via GitHub Actions, served from
 * Cloudflare with strong ETags).
 *
 * This is the same source opencode itself uses to populate its TUI model
 * browser, so values for the opencode provider rows are authoritative.
 *
 * Lookup strategy per (our-provider-id, model-id) pair:
 *   1. Map our provider id to the models.dev provider id
 *      (e.g. `regolo` → `regolo-ai`, `opencode-zen` → `opencode`).
 *   2. Exact id match on the provider's `models` map.
 *   3. Case-insensitive id match (regolo uses mixed-case ids; models.dev
 *      uses lowercase — `Llama-3.3-70B-Instruct` vs `llama-3.3-70b-instruct`).
 *   4. Return `undefined` on miss — callers fall through to their own
 *      provider-native catalog, hardcoded table, or 32K default.
 *
 * All errors (network, timeout, parse, schema) collapse to `undefined`
 * so the helper can sit at the back of any provider's lookup chain
 * without breaking the rest of the stack.
 */
const MODELSDEV_URL = "https://models.dev/api.json";
const CATALOG_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

export type FetchModelsDevCatalog = typeof fetch;

export interface ModelsDevModelRecord {
  id: string;
  limit?: { context?: number | null; output?: number | null; input?: number | null };
  status?: string;
}

export interface ModelsDevProvider {
  models?: Record<string, ModelsDevModelRecord>;
}

export type ModelsDevCatalog = Record<string, ModelsDevProvider | undefined>;

/**
 * Map our provider ids to the provider keys used in models.dev.
 * Add new entries here when registering a provider whose models.dev id
 * doesn't match ours (e.g. we use a stable id but models.dev uses a
 * more verbose one).
 */
export const MODELSDEV_PROVIDER_ID_MAP: Readonly<Record<string, string>> = {
  openrouter: "openrouter",
  openai: "openai",
  regolo: "regolo-ai",
  cerebras: "cerebras",
  anthropic: "anthropic",
  "opencode-go": "opencode-go",
  "opencode-zen": "opencode",
  "command-code": "command-code",
};

interface CachedCatalog {
  catalog: ModelsDevCatalog;
  etag: string | null;
  fetchedAt: number;
  /** Lowercase-id mirror of each provider's model map for case-insensitive lookups. */
  lowerIndex: Map<string, Map<string, ModelsDevModelRecord>>;
}

let cache: CachedCatalog | null = null;

/** @internal test helper */
export function resetModelsDevCache(): void {
  cache = null;
}

async function fetchWithTimeout(
  fetchImpl: FetchModelsDevCatalog,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildLowerIndex(catalog: ModelsDevCatalog): Map<string, Map<string, ModelsDevModelRecord>> {
  const index = new Map<string, Map<string, ModelsDevModelRecord>>();
  for (const [providerId, provider] of Object.entries(catalog)) {
    if (!provider?.models) continue;
    const lower = new Map<string, ModelsDevModelRecord>();
    for (const [id, model] of Object.entries(provider.models)) {
      lower.set(id.toLowerCase(), model);
    }
    index.set(providerId, lower);
  }
  return index;
}

export async function loadModelsDevCatalog(
  fetchImpl: FetchModelsDevCatalog = fetch,
): Promise<ModelsDevCatalog> {
  if (cache && Date.now() - cache.fetchedAt < CATALOG_TTL_MS) {
    return cache.catalog;
  }

  const headers: Record<string, string> = {};
  if (cache?.etag) headers["If-None-Match"] = cache.etag;

  const response = await fetchWithTimeout(fetchImpl, MODELSDEV_URL, { headers });
  if (response.status === 304 && cache) {
    cache.fetchedAt = Date.now();
    return cache.catalog;
  }
  if (!response.ok) {
    throw new Error(`models.dev catalog failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as ModelsDevCatalog;
  const etag = response.headers.get("etag");
  cache = {
    catalog: body,
    etag,
    fetchedAt: Date.now(),
    lowerIndex: buildLowerIndex(body),
  };
  return body;
}

/** Context window for a model id, looked up against the models.dev catalog. */
export async function lookupModelsDevContextWindow(
  ourProviderId: string,
  modelId: string,
  fetchImpl?: FetchModelsDevCatalog,
): Promise<number | undefined> {
  try {
    if (cache) {
      const directHit = resolveFromCache(cache, ourProviderId, modelId);
      if (directHit !== undefined) return directHit;
    }
    await loadModelsDevCatalog(fetchImpl);
    if (!cache) return undefined;
    return resolveFromCache(cache, ourProviderId, modelId);
  } catch {
    return undefined;
  }
}

function resolveFromCache(
  cacheEntry: CachedCatalog,
  ourProviderId: string,
  modelId: string,
): number | undefined {
  const mappedId = MODELSDEV_PROVIDER_ID_MAP[ourProviderId] ?? ourProviderId;
  const provider = cacheEntry.catalog[mappedId];
  if (!provider?.models) return undefined;

  const exact = provider.models[modelId];
  const model = exact ?? cacheEntry.lowerIndex.get(mappedId)?.get(modelId.toLowerCase());
  if (!model) return undefined;

  const context = model.limit?.context;
  return typeof context === "number" && context > 0 ? context : undefined;
}
