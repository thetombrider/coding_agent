/**
 * Shared factory for OpenAI-compatible LLM backends (Regolo, native OpenAI, etc.).
 * Uses `@ai-sdk/openai` with an optional custom baseURL — not OpenRouter's SDK.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { loadConfig, type Config } from "../config/config.js";
import type { ModelMetadataProvider, Provider, ProviderDefaultModels } from "./types.js";

export interface OpenAiCompatibleProviderConfig {
  id: string;
  displayName: string;
  envVar: string;
  configSection: keyof Pick<Config["provider"], "regolo" | "openai">;
  baseURL?: string;
  /** Strip this prefix from model ids (e.g. `regolo:`). */
  idPrefix?: string;
  /** Defaults to `${baseURL}/models` when baseURL is set. */
  modelsListUrl?: string;
  /** Curated ids for the `/model` picker when this provider is active. */
  pickerModels: readonly string[];
  defaultModels: ProviderDefaultModels;
}

const CATALOG_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

export type FetchModelsCatalog = typeof fetch;

interface OpenAiModelRecord {
  id: string;
  context_length?: number | null;
  context_window?: number | null;
  max_context_length?: number | null;
  max_model_len?: number | null;
}

interface OpenAiModelsResponse {
  data: OpenAiModelRecord[];
}

let catalogCache: Map<string, number> | null = null;
let catalogIdsCache: string[] | null = null;
let catalogFetchedAt = 0;
let catalogCacheKey = "";

/** @internal test helper */
export function resetOpenAiCompatibleModelsCache(): void {
  catalogCache = null;
  catalogIdsCache = null;
  catalogFetchedAt = 0;
  catalogCacheKey = "";
}

function resolveContextLength(model: OpenAiModelRecord): number | undefined {
  for (const value of [
    model.context_length,
    model.context_window,
    model.max_context_length,
    model.max_model_len,
  ]) {
    if (typeof value === "number" && value > 0) return value;
  }
  return undefined;
}

/** fetch with a bounded timeout so a stalled metadata call fails fast instead of hanging. */
export async function fetchWithTimeout(
  fetchImpl: FetchModelsCatalog,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function getApiKey(envVar: string, configSection: OpenAiCompatibleProviderConfig["configSection"]): string | undefined {
  const fromEnv = process.env[envVar]?.trim();
  if (fromEnv) return fromEnv;
  const section = loadConfig().provider[configSection];
  const apiKey = section && typeof section === "object" && "apiKey" in section
    ? (section as { apiKey?: string }).apiKey?.trim()
    : undefined;
  return apiKey || undefined;
}

function normalizeModelId(modelId: string, idPrefix?: string): string {
  if (idPrefix && modelId.startsWith(idPrefix)) {
    return modelId.slice(idPrefix.length);
  }
  return modelId;
}

function modelsListUrl(cfg: OpenAiCompatibleProviderConfig): string | undefined {
  if (cfg.modelsListUrl) return cfg.modelsListUrl;
  if (cfg.baseURL) return `${cfg.baseURL.replace(/\/$/, "")}/models`;
  return undefined;
}

function requestInit(apiKey?: string): RequestInit {
  if (!apiKey) return {};
  return { headers: { Authorization: `Bearer ${apiKey}` } };
}

export async function loadOpenAiCompatibleModelsCatalog(
  cfg: OpenAiCompatibleProviderConfig,
  fetchImpl: FetchModelsCatalog = fetch,
  apiKey?: string,
): Promise<Map<string, number>> {
  const url = modelsListUrl(cfg);
  if (!url) return new Map();

  const cacheKey = `${cfg.id}:${url}`;
  if (catalogCache && catalogCacheKey === cacheKey && Date.now() - catalogFetchedAt < CATALOG_TTL_MS) {
    return catalogCache;
  }

  const key = apiKey ?? getApiKey(cfg.envVar, cfg.configSection);
  const response = await fetchWithTimeout(fetchImpl, url, requestInit(key));
  if (!response.ok) {
    throw new Error(`${cfg.displayName} models API failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as OpenAiModelsResponse;
  const next = new Map<string, number>();
  const ids: string[] = [];

  for (const model of body.data ?? []) {
    ids.push(model.id);
    const contextWindow = resolveContextLength(model);
    if (contextWindow !== undefined) next.set(model.id, contextWindow);
  }

  catalogCache = next;
  catalogIdsCache = ids;
  catalogFetchedAt = Date.now();
  catalogCacheKey = cacheKey;
  return next;
}

/** Model ids from the OpenAI-compatible /models endpoint (reuses the catalog cache). */
export async function listOpenAiCompatibleModelIds(
  cfg: OpenAiCompatibleProviderConfig,
  fetchImpl: FetchModelsCatalog = fetch,
  apiKey?: string,
): Promise<string[]> {
  const url = modelsListUrl(cfg);
  const cacheKey = `${cfg.id}:${url ?? ""}`;
  if (catalogIdsCache && catalogCacheKey === cacheKey && Date.now() - catalogFetchedAt < CATALOG_TTL_MS) {
    return catalogIdsCache;
  }
  await loadOpenAiCompatibleModelsCatalog(cfg, fetchImpl, apiKey);
  return catalogIdsCache ?? [];
}

export async function lookupOpenAiCompatibleContextWindow(
  cfg: OpenAiCompatibleProviderConfig,
  modelId: string,
  fetchImpl: FetchModelsCatalog = fetch,
  apiKey?: string,
): Promise<number | undefined> {
  const normalized = normalizeModelId(modelId, cfg.idPrefix);
  try {
    const catalog = await loadOpenAiCompatibleModelsCatalog(cfg, fetchImpl, apiKey);
    return catalog.get(normalized);
  } catch {
    return undefined;
  }
}

/**
 * Factory for OpenAI-compatible provider backends. Regolo and future native
 * OpenAI are thin wrappers around this helper.
 */
export function createOpenAiCompatibleProvider(cfg: OpenAiCompatibleProviderConfig): Provider {
  function resolveApiKey(): string | undefined {
    return getApiKey(cfg.envVar, cfg.configSection);
  }

  function getClient() {
    const apiKey = resolveApiKey();
    if (!apiKey) {
      throw new Error(`${cfg.envVar} is not set (env var or ~/.orin/config.json)`);
    }
    return createOpenAI({
      apiKey,
      ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    });
  }

  const metadata: ModelMetadataProvider = {
    id: cfg.id,
    supportsModel(modelId) {
      if (modelId.startsWith("faux:")) return false;
      if (cfg.idPrefix && modelId.startsWith(cfg.idPrefix)) return true;
      if (catalogCache && catalogCacheKey.startsWith(`${cfg.id}:`)) {
        const normalized = normalizeModelId(modelId, cfg.idPrefix);
        return catalogIdsCache?.includes(normalized) ?? catalogCache.has(normalized);
      }
      const normalized = normalizeModelId(modelId, cfg.idPrefix);
      return !normalized.includes("/");
    },
    getContextWindow(modelId) {
      return lookupOpenAiCompatibleContextWindow(cfg, modelId);
    },
    listModelIds() {
      return listOpenAiCompatibleModelIds(cfg);
    },
  };

  return {
    id: cfg.id,
    displayName: cfg.displayName,
    authStrategy: "api-key",
    configFields: [
      {
        key: "apiKey",
        label: `${cfg.displayName} API key`,
        secret: true,
        envVar: cfg.envVar,
      },
    ],
    isConfigured() {
      return Boolean(resolveApiKey());
    },
    normalizeModelId(modelId) {
      return normalizeModelId(modelId, cfg.idPrefix);
    },
    languageModel(modelId) {
      return getClient().chat(normalizeModelId(modelId, cfg.idPrefix));
    },
    metadata,
    pickerModels: cfg.pickerModels,
    defaultModels: cfg.defaultModels,
  };
}
