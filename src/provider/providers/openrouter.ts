/**
 * OpenRouter provider — the single, self-contained OpenRouter backend behind
 * the provider abstraction. It owns everything OpenRouter-specific:
 *   - credentials + AI SDK client and model-id normalization
 *   - model metadata / context-window lookups (the openrouter.ai model API)
 *   - prompt-cache strategy, exposed to the shared stream path via the
 *     Provider's optional `streamProviderOptions` / `markCacheBreakpoints` hooks
 *
 * There is exactly one implementation per provider; `stream.ts` and the other
 * core call paths stay provider-agnostic and reach this through the registry.
 */
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { ModelMessage } from "ai";
import { loadConfig } from "../../config/config.js";
import type { ModelPricing } from "../../config/config.js";
import type { ModelMetadataProvider, Provider } from "../types.js";

// ── Client & credentials ─────────────────────────────────────────────────────

/** OpenRouter API key from config; undefined when not configured. */
export function getOpenRouterApiKey(): string | undefined {
  return loadConfig().provider.openrouter?.apiKey?.trim();
}

export function getOpenRouter() {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    throw new Error(
      "OpenRouter is not configured — set provider.openrouter.apiKey in ~/.orin/config.json "
      + "or run /providers configure openrouter",
    );
  }
  return createOpenRouter({ apiKey });
}

/** Resolve an OpenRouter model id (strip optional `openrouter:` prefix). */
export function resolveOpenRouterModelId(modelId: string): string {
  return modelId.startsWith("openrouter:")
    ? modelId.slice("openrouter:".length)
    : modelId;
}

// ── Model metadata / context-window lookup ───────────────────────────────────

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
  pricing?: {
    prompt?: string;
    completion?: string;
    request?: string;
    image?: string;
  };
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
let catalogPricingCache: Map<string, ModelPricing> | null = null;
let catalogIdsCache: string[] | null = null;
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
  catalogPricingCache = null;
  catalogIdsCache = null;
  catalogFetchedAt = 0;
}

/** OpenRouter API returns USD per token; Orin config uses per-million. */
export function openRouterTokenPricingToPerM(pricing: {
  prompt?: string;
  completion?: string;
}): ModelPricing | undefined {
  const prompt = parseFloat(pricing.prompt ?? "");
  const completion = parseFloat(pricing.completion ?? "");
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return undefined;
  return {
    inputPerM: prompt * 1_000_000,
    outputPerM: completion * 1_000_000,
  };
}

const OPENROUTER_FETCH_TIMEOUT_MS = 8000;

/** fetch with a bounded timeout so a stalled metadata call fails fast instead of hanging. */
async function fetchWithTimeout(
  fetchImpl: FetchModelsCatalog,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENROUTER_FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSingleModelContextWindow(
  modelId: string,
  fetchImpl: FetchModelsCatalog,
  apiKey?: string,
): Promise<number | undefined> {
  const url = openRouterModelLookupUrl(modelId);
  if (!url) return undefined;

  const response = await fetchWithTimeout(fetchImpl, url, openRouterRequestInit(apiKey));
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

  const response = await fetchWithTimeout(
    fetchImpl,
    OPENROUTER_MODELS_URL,
    openRouterRequestInit(apiKey),
  );
  if (!response.ok) {
    throw new Error(`OpenRouter models API failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as OpenRouterModelsResponse;
  const next = new Map<string, number>();
  const pricingNext = new Map<string, ModelPricing>();
  const ids: string[] = [];

  for (const model of body.data) {
    ids.push(model.id);
    const contextWindow = resolveContextLength(model);
    if (contextWindow !== undefined) {
      next.set(model.id, contextWindow);
      if (model.canonical_slug) next.set(model.canonical_slug, contextWindow);
    }
    const modelPricing = model.pricing ? openRouterTokenPricingToPerM(model.pricing) : undefined;
    if (modelPricing) {
      pricingNext.set(model.id, modelPricing);
      if (model.canonical_slug) pricingNext.set(model.canonical_slug, modelPricing);
    }
  }

  catalogCache = next;
  catalogPricingCache = pricingNext;
  catalogIdsCache = ids;
  catalogFetchedAt = Date.now();
  return next;
}

/** Pricing from the cached OpenRouter catalog (populated by `loadOpenRouterModelsCatalog`). */
export function lookupOpenRouterPricing(modelId: string): ModelPricing | undefined {
  if (!catalogPricingCache) return undefined;
  for (const key of lookupKeys(modelId)) {
    const match = catalogPricingCache.get(key);
    if (match) return match;
  }
  return undefined;
}

/** Model ids from the OpenRouter catalog (reuses the catalog cache). */
export async function listOpenRouterModelIds(
  fetchImpl: FetchModelsCatalog = fetch,
  apiKey?: string,
): Promise<string[]> {
  if (catalogIdsCache && Date.now() - catalogFetchedAt < CATALOG_TTL_MS) {
    return catalogIdsCache;
  }
  await loadOpenRouterModelsCatalog(fetchImpl, apiKey);
  return catalogIdsCache ?? [];
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

// ── Prompt-cache strategy ────────────────────────────────────────────────────

const EPHEMERAL_CACHE = { type: "ephemeral" as const };

/** How a model/provider combo participates in OpenRouter prompt caching. */
export type PromptCacheStrategy =
  | "explicit-breakpoints"
  | "implicit-only"
  | "none";

const QWEN_EXPLICIT_PREFIXES = [
  "qwen/qwen3-max",
  "qwen/qwen-plus",
  "qwen/qwen3.6-plus",
  "qwen/qwen3-coder-plus",
  "qwen/qwen3-coder-flash",
  "qwen/qwen3.7-max",
  "qwen/qwen3.7-plus",
] as const;

/** Snapshot Qwen endpoints do not support explicit cache_control on OpenRouter. */
const QWEN_SNAPSHOT_PATTERN = /^qwen\/qwen3\.5-(plus|flash)-\d{2}-\d{2}/;

function matchesModelPrefix(id: string, prefix: string): boolean {
  return id === prefix || id.startsWith(`${prefix}:`);
}

function isQwenExplicitCachingModel(id: string): boolean {
  if (!id.startsWith("qwen/")) return false;
  if (QWEN_SNAPSHOT_PATTERN.test(id)) return false;
  return QWEN_EXPLICIT_PREFIXES.some((prefix) => matchesModelPrefix(id, prefix));
}

export function getPromptCacheStrategy(modelId: string): PromptCacheStrategy {
  const id = resolveOpenRouterModelId(modelId);

  if (id.startsWith("anthropic/")) return "explicit-breakpoints";
  if (id === "deepseek/deepseek-v3.2") return "explicit-breakpoints";
  if (isQwenExplicitCachingModel(id)) return "explicit-breakpoints";
  if (id.startsWith("google/gemini")) return "explicit-breakpoints";

  if (id.startsWith("openai/")) return "implicit-only";
  if (id.startsWith("deepseek/")) return "implicit-only";
  if (id.startsWith("minimax/")) return "implicit-only";
  if (id.startsWith("moonshotai/")) return "implicit-only";
  if (id.startsWith("x-ai/")) return "implicit-only";

  return "none";
}

/** True when the model can benefit from prompt caching (explicit or implicit). */
export function supportsPromptCaching(modelId: string): boolean {
  return getPromptCacheStrategy(modelId) !== "none";
}

/** True when cache_control breakpoints should be sent in the request. */
export function requiresExplicitCacheBreakpoints(modelId: string): boolean {
  return getPromptCacheStrategy(modelId) === "explicit-breakpoints";
}

export function promptCacheProviderOptions(modelId: string) {
  if (!requiresExplicitCacheBreakpoints(modelId)) return undefined;
  return {
    anthropic: { cacheControl: EPHEMERAL_CACHE },
  };
}

/** Mark the stable conversation prefix for caching (penultimate converted message). */
export function markPromptCacheBreakpoints(
  aiMessages: ModelMessage[],
  modelId: string,
): void {
  const providerOptions = promptCacheProviderOptions(modelId);
  if (!providerOptions || aiMessages.length < 2) return;

  const target = aiMessages[aiMessages.length - 2]!;
  target.providerOptions = {
    ...target.providerOptions,
    ...providerOptions,
  };
}

const MAX_SESSION_ID_LENGTH = 256;

/** Provider options for streamText: explicit cache hints + OpenRouter session stickiness. */
export function buildStreamProviderOptions(
  modelId: string,
  sessionId?: string,
): SharedV3ProviderOptions | undefined {
  const result: SharedV3ProviderOptions = {};
  const cache = promptCacheProviderOptions(modelId);
  if (cache) Object.assign(result, cache);

  if (sessionId) {
    result.openrouter = {
      session_id: sessionId.slice(0, MAX_SESSION_ID_LENGTH),
    };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

// ── Provider implementation ──────────────────────────────────────────────────

/** Curated OpenRouter models for the `/model` picker. */
export const OPENROUTER_PICKER_MODELS = [
  "anthropic/claude-opus-4.8",
  "anthropic/claude-sonnet-4.6",
  "google/gemini-3.5-flash",
  "google/gemini-3.1-flash-lite",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "minimax/minimax-m3",
  "moonshotai/kimi-k2.7-code",
  "z-ai/glm-5.2",
  "qwen/qwen3.7-plus",
  "xiaomi/mimo-v2.5-pro",
  "inception/mercury-2",
  "arcee-ai/trinity-large-thinking",
  "mistralai/mistral-large-2512",
] as const;

export const OPENROUTER_DEFAULT_MAIN = "anthropic/claude-sonnet-4.6";
export const OPENROUTER_DEFAULT_CHEAP = "deepseek/deepseek-v4-flash";

const metadata: ModelMetadataProvider = {
  id: "openrouter",
  supportsModel(modelId) {
    if (modelId.startsWith("faux:")) return false;
    return resolveOpenRouterModelId(modelId).includes("/");
  },
  getContextWindow(modelId) {
    return lookupOpenRouterContextWindow(modelId);
  },
  listModelIds() {
    return listOpenRouterModelIds();
  },
};

/**
 * Default provider: routes models through OpenRouter using an API key.
 * Behaviour is identical to the pre-registry direct call path.
 */
export const openRouterProvider: Provider = {
  id: "openrouter",
  displayName: "OpenRouter",
  authStrategy: "api-key",
  configFields: [
    { key: "apiKey", label: "OpenRouter API key", secret: true },
  ],
  isConfigured() {
    return Boolean(getOpenRouterApiKey());
  },
  normalizeModelId(modelId) {
    return resolveOpenRouterModelId(modelId);
  },
  languageModel(modelId) {
    return getOpenRouter().chat(resolveOpenRouterModelId(modelId));
  },
  streamProviderOptions(modelId, sessionId) {
    return buildStreamProviderOptions(modelId, sessionId);
  },
  markCacheBreakpoints(aiMessages, modelId) {
    markPromptCacheBreakpoints(aiMessages, modelId);
  },
  metadata,
  pickerModels: OPENROUTER_PICKER_MODELS,
  defaultModels: {
    main: OPENROUTER_DEFAULT_MAIN,
    cheap: OPENROUTER_DEFAULT_CHEAP,
  },
};
