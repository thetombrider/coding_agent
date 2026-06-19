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
/** Required beta flag when using subscription OAuth tokens with the Messages API. */
export const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

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

/** Prefer API key over OAuth unless `preferredAuth` selects OAuth when both exist. */
export function resolveAnthropicAuth():
  | { kind: "api-key"; apiKey: string }
  | { kind: "oauth"; accessToken: string }
  | undefined {
  const apiKey = getAnthropicApiKey();
  const tokens = getAnthropicOAuthTokens();
  const oauthReady = hasValidOAuthTokens(tokens, REFRESH_SKEW_MS);
  const hasOAuth = oauthReady || Boolean(tokens?.refreshToken);
  const preferred = loadConfig().provider.anthropic?.preferredAuth;

  if (apiKey && hasOAuth) {
    if (preferred === "oauth" && oauthReady) {
      return { kind: "oauth", accessToken: tokens!.accessToken };
    }
    return { kind: "api-key", apiKey };
  }
  if (apiKey) return { kind: "api-key", apiKey };
  if (oauthReady) return { kind: "oauth", accessToken: tokens!.accessToken };
  if (tokens?.refreshToken && tokens.accessToken) {
    return { kind: "oauth", accessToken: tokens.accessToken };
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

/** Build createAnthropic() options for the resolved auth path. */
export function anthropicClientOptions(
  auth: NonNullable<ReturnType<typeof resolveAnthropicAuth>>,
): { apiKey: string; headers?: Record<string, string> } {
  if (auth.kind === "api-key") {
    return { apiKey: auth.apiKey };
  }
  // Anthropic rejects OAuth tokens sent via Authorization: Bearer — use x-api-key instead.
  return {
    apiKey: auth.accessToken,
    headers: { "anthropic-beta": ANTHROPIC_OAUTH_BETA },
  };
}

function createAnthropicClient(auth: NonNullable<ReturnType<typeof resolveAnthropicAuth>>) {
  const opts = anthropicClientOptions(auth);
  return createAnthropic(opts);
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

/**
 * Map legacy OpenRouter-style ids (and retired native ids) to current Anthropic API ids.
 * @see https://platform.claude.com/docs/en/about-claude/models/overview
 * @see https://platform.claude.com/docs/en/about-claude/model-deprecations
 */
export const ANTHROPIC_MODEL_ALIASES: Record<string, string> = {
  // OpenRouter-style ids (provider/model with dotted minor versions)
  "anthropic/claude-opus-4.8": "claude-opus-4-8",
  "anthropic/claude-sonnet-4.6": "claude-sonnet-4-6",
  "anthropic/claude-sonnet-4": "claude-sonnet-4-6",
  "anthropic/claude-3-5-haiku": "claude-haiku-4-5",
  "anthropic/claude-3-5-sonnet": "claude-sonnet-4-6",
  // Retired native snapshots → current replacements
  "claude-sonnet-4-20250514": "claude-sonnet-4-6",
  "claude-opus-4-20250514": "claude-opus-4-8",
  "claude-3-5-haiku-20241022": "claude-haiku-4-5",
  "claude-3-5-sonnet-20241022": "claude-sonnet-4-6",
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
const DEFAULT_SONNET_CONTEXT = 1_000_000;
const DEFAULT_HAIKU_CONTEXT = 200_000;

export type FetchModelsCatalog = typeof fetch;

interface AnthropicModelRecord {
  id: string;
  display_name?: string;
  max_input_tokens?: number;
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
      "x-api-key": auth.accessToken,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": ANTHROPIC_OAUTH_BETA,
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
    const contextWindow = model.max_input_tokens;
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

  if (resolveAnthropicModelId(modelId).startsWith("claude-haiku-")) {
    return DEFAULT_HAIKU_CONTEXT;
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

/** Curated models for `/model` when Anthropic is active (official API ids). */
export const ANTHROPIC_PICKER_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-opus-4-7",
  "claude-sonnet-4-5",
] as const;

export const ANTHROPIC_DEFAULT_MAIN = "claude-sonnet-4-6";
export const ANTHROPIC_DEFAULT_CHEAP = "claude-haiku-4-5";

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
    if (!hasAnthropicOAuthTokens()) return;
    const preferred = loadConfig().provider.anthropic?.preferredAuth;
    if (!getAnthropicApiKey() || preferred === "oauth") {
      await ensureAnthropicOAuthAccessToken();
    }
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
