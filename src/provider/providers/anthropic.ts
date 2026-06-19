/**
 * Anthropic provider — native Messages API backend via @ai-sdk/anthropic.
 * Supports API key (Console billing) and OAuth (Claude subscription) auth paths.
 */
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { ModelMessage } from "ai";
import { loadConfig } from "../../config/config.js";
import {
  refreshAnthropicOAuthTokens,
  type FetchImpl,
} from "../oauth/anthropic-oauth.js";
import {
  hasValidOAuthTokens,
  loadProviderTokens,
  saveProviderTokens,
  type ProviderOAuthTokens,
} from "../oauth/tokens.js";
import type { ModelMetadataProvider, Provider } from "../types.js";

// ── Credentials ───────────────────────────────────────────────────────────────

const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Anthropic API key from env or config; undefined when not configured. */
export function getAnthropicApiKey(): string | undefined {
  return (
    process.env.ANTHROPIC_API_KEY?.trim() ||
    loadConfig().provider.anthropic?.apiKey?.trim()
  );
}

export function getAnthropicOAuthTokens(): ProviderOAuthTokens | undefined {
  return loadProviderTokens("anthropic");
}

export function hasAnthropicOAuthTokens(): boolean {
  const tokens = getAnthropicOAuthTokens();
  if (!tokens?.accessToken) return false;
  return hasValidOAuthTokens(tokens) || Boolean(tokens.refreshToken);
}

/** Prefer API key over OAuth (env → config, then tokens.json). */
export function resolveAnthropicAuth():
  | { kind: "api-key"; apiKey: string }
  | { kind: "oauth"; accessToken: string }
  | undefined {
  const apiKey = getAnthropicApiKey();
  if (apiKey) return { kind: "api-key", apiKey };

  const tokens = getAnthropicOAuthTokens();
  if (hasValidOAuthTokens(tokens, REFRESH_SKEW_MS)) {
    return { kind: "oauth", accessToken: tokens!.accessToken };
  }
  return undefined;
}

let refreshPromise: Promise<ProviderOAuthTokens> | null = null;

/** Refresh OAuth tokens when near expiry; returns the active access token. */
export async function ensureAnthropicOAuthAccessToken(
  fetchImpl: FetchImpl = fetch,
): Promise<string | undefined> {
  const tokens = getAnthropicOAuthTokens();
  if (!tokens?.accessToken) return undefined;
  if (hasValidOAuthTokens(tokens, REFRESH_SKEW_MS)) return tokens.accessToken;
  if (!tokens.refreshToken) return undefined;

  if (!refreshPromise) {
    refreshPromise = refreshAnthropicOAuthTokens(tokens.refreshToken, fetchImpl)
      .then((refreshed) => {
        saveProviderTokens("anthropic", refreshed);
        return refreshed;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  const refreshed = await refreshPromise;
  return refreshed.accessToken;
}

function createAnthropicClient(auth: NonNullable<ReturnType<typeof resolveAnthropicAuth>>) {
  if (auth.kind === "api-key") {
    return createAnthropic({ apiKey: auth.apiKey });
  }
  return createAnthropic({ authToken: auth.accessToken });
}

export function getAnthropic() {
  const auth = resolveAnthropicAuth();
  if (!auth) {
    throw new Error(
      "Anthropic is not configured — set ANTHROPIC_API_KEY (env or ~/.orin/config.json) "
      + "or authenticate via /providers oauth anthropic",
    );
  }
  return createAnthropicClient(auth);
}

// ── Model id normalization ────────────────────────────────────────────────────

/** Map legacy OpenRouter-style ids to native Anthropic slugs. */
export const ANTHROPIC_MODEL_ALIASES: Record<string, string> = {
  "anthropic/claude-opus-4.8": "claude-opus-4-20250514",
  "anthropic/claude-sonnet-4.6": "claude-sonnet-4-20250514",
  "anthropic/claude-sonnet-4": "claude-sonnet-4-20250514",
  "anthropic/claude-3-5-haiku": "claude-3-5-haiku-20241022",
  "anthropic/claude-3-5-sonnet": "claude-3-5-sonnet-20241022",
};

/** Resolve an Anthropic model id (strip optional `anthropic:` prefix, apply aliases). */
export function resolveAnthropicModelId(modelId: string): string {
  let id = modelId.startsWith("anthropic:") ? modelId.slice("anthropic:".length) : modelId;
  return ANTHROPIC_MODEL_ALIASES[id] ?? id;
}

// ── Model metadata ────────────────────────────────────────────────────────────

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const LOOKUP_TTL_MS = 60 * 60 * 1000;
const CATALOG_TTL_MS = 60 * 60 * 1000;
const ANTHROPIC_FETCH_TIMEOUT_MS = 8000;
const DEFAULT_SONNET_CONTEXT = 200_000;

export type FetchModelsCatalog = typeof fetch;

interface AnthropicModelRecord {
  id: string;
  display_name?: string;
  context_window?: number;
}

interface AnthropicModelsResponse {
  data: AnthropicModelRecord[];
}

let lookupCache = new Map<string, { value: number | undefined; fetchedAt: number }>();
let catalogCache: Map<string, number> | null = null;
let catalogIdsCache: string[] | null = null;
let catalogFetchedAt = 0;

/** @internal test helper */
export function resetAnthropicModelsCache(): void {
  lookupCache.clear();
  catalogCache = null;
  catalogIdsCache = null;
  catalogFetchedAt = 0;
}

async function fetchWithTimeout(
  fetchImpl: FetchModelsCatalog,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANTHROPIC_FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function anthropicRequestInit(): RequestInit {
  const auth = resolveAnthropicAuth();
  if (!auth) return {};
  if (auth.kind === "api-key") {
    return { headers: { "x-api-key": auth.apiKey, "anthropic-version": "2023-06-01" } };
  }
  return {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      "anthropic-version": "2023-06-01",
    },
  };
}

function lookupKeys(modelId: string): string[] {
  const normalized = resolveAnthropicModelId(modelId);
  const keys = [normalized, modelId];
  const alias = ANTHROPIC_MODEL_ALIASES[modelId];
  if (alias) keys.push(alias);
  return [...new Set(keys)];
}

export async function loadAnthropicModelsCatalog(
  fetchImpl: FetchModelsCatalog = fetch,
): Promise<Map<string, number>> {
  if (catalogCache && Date.now() - catalogFetchedAt < CATALOG_TTL_MS) {
    return catalogCache;
  }

  const response = await fetchWithTimeout(fetchImpl, ANTHROPIC_MODELS_URL, anthropicRequestInit());
  if (!response.ok) {
    throw new Error(`Anthropic models API failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as AnthropicModelsResponse;
  const next = new Map<string, number>();
  const ids: string[] = [];

  for (const model of body.data) {
    ids.push(model.id);
    const contextWindow = model.context_window;
    if (typeof contextWindow === "number" && contextWindow > 0) {
      next.set(model.id, contextWindow);
    }
  }

  catalogCache = next;
  catalogIdsCache = ids;
  catalogFetchedAt = Date.now();
  return next;
}

export async function listAnthropicModelIds(
  fetchImpl: FetchModelsCatalog = fetch,
): Promise<string[]> {
  if (catalogIdsCache && Date.now() - catalogFetchedAt < CATALOG_TTL_MS) {
    return catalogIdsCache;
  }
  await loadAnthropicModelsCatalog(fetchImpl);
  return catalogIdsCache ?? [];
}

export async function lookupAnthropicContextWindow(
  modelId: string,
  fetchImpl: FetchModelsCatalog = fetch,
): Promise<number | undefined> {
  for (const key of lookupKeys(modelId)) {
    const cached = lookupCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < LOOKUP_TTL_MS) {
      if (cached.value !== undefined) return cached.value;
      continue;
    }
  }

  try {
    const catalog = await loadAnthropicModelsCatalog(fetchImpl);
    for (const key of lookupKeys(modelId)) {
      const match = catalog.get(key);
      if (match !== undefined) {
        lookupCache.set(key, { value: match, fetchedAt: Date.now() });
        return match;
      }
    }
  } catch {
    // Fall through to config defaults.
  }

  const fromConfig = loadConfig().models.contextWindows[modelId]
    ?? loadConfig().models.contextWindows[resolveAnthropicModelId(modelId)];
  if (typeof fromConfig === "number" && fromConfig > 0) {
    lookupCache.set(modelId, { value: fromConfig, fetchedAt: Date.now() });
    return fromConfig;
  }

  if (resolveAnthropicModelId(modelId).startsWith("claude-")) {
    return DEFAULT_SONNET_CONTEXT;
  }

  return undefined;
}

// ── Prompt cache ──────────────────────────────────────────────────────────────

const EPHEMERAL_CACHE = { type: "ephemeral" as const };

export function supportsAnthropicPromptCaching(modelId: string): boolean {
  return resolveAnthropicModelId(modelId).startsWith("claude-");
}

export function anthropicPromptCacheProviderOptions(): SharedV3ProviderOptions {
  return {
    anthropic: { cacheControl: EPHEMERAL_CACHE },
  };
}

/** Mark the stable conversation prefix for caching (penultimate converted message). */
export function markAnthropicCacheBreakpoints(aiMessages: ModelMessage[]): void {
  if (aiMessages.length < 2) return;
  const target = aiMessages[aiMessages.length - 2]!;
  target.providerOptions = {
    ...target.providerOptions,
    ...anthropicPromptCacheProviderOptions(),
  };
}

export function buildAnthropicStreamProviderOptions(
  modelId: string,
): SharedV3ProviderOptions | undefined {
  if (!supportsAnthropicPromptCaching(modelId)) return undefined;
  return anthropicPromptCacheProviderOptions();
}

// ── Provider export ─────────────────────────────────────────────────────────

export const ANTHROPIC_PICKER_MODELS = [
  "claude-opus-4-20250514",
  "claude-sonnet-4-20250514",
  "claude-3-5-haiku-20241022",
  "claude-3-5-sonnet-20241022",
] as const;

export const ANTHROPIC_DEFAULT_MAIN = "claude-sonnet-4-20250514";
export const ANTHROPIC_DEFAULT_CHEAP = "claude-3-5-haiku-20241022";

const metadata: ModelMetadataProvider = {
  id: "anthropic",
  supportsModel(modelId) {
    if (modelId.startsWith("faux:")) return false;
    const normalized = resolveAnthropicModelId(modelId);
    if (normalized.startsWith("claude-")) return true;
    if (modelId.startsWith("anthropic/")) return true;
    return false;
  },
  getContextWindow(modelId) {
    return lookupAnthropicContextWindow(modelId);
  },
  listModelIds() {
    return listAnthropicModelIds();
  },
};

export const anthropicProvider: Provider = {
  id: "anthropic",
  displayName: "Anthropic",
  authStrategy: "api-key-or-oauth",
  configFields: [
    {
      key: "apiKey",
      label: "Anthropic API key",
      secret: true,
      envVar: "ANTHROPIC_API_KEY",
    },
  ],
  async prepareCredentials() {
    if (getAnthropicApiKey()) return;
    await ensureAnthropicOAuthAccessToken();
  },
  isConfigured() {
    return Boolean(getAnthropicApiKey()) || hasAnthropicOAuthTokens();
  },
  normalizeModelId(modelId) {
    return resolveAnthropicModelId(modelId);
  },
  languageModel(modelId) {
    return getAnthropic().languageModel(resolveAnthropicModelId(modelId));
  },
  streamProviderOptions(modelId) {
    return buildAnthropicStreamProviderOptions(modelId);
  },
  markCacheBreakpoints(aiMessages, modelId) {
    if (supportsAnthropicPromptCaching(modelId)) {
      markAnthropicCacheBreakpoints(aiMessages);
    }
  },
  metadata,
  pickerModels: ANTHROPIC_PICKER_MODELS,
  defaultModels: {
    main: ANTHROPIC_DEFAULT_MAIN,
    cheap: ANTHROPIC_DEFAULT_CHEAP,
  },
};
