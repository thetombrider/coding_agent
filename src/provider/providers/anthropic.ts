/**
 * Anthropic provider — native Messages API backend via @ai-sdk/anthropic.
 * Authenticates with a Console API key (env or ~/.orin/config.json).
 */
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { ModelMessage } from "ai";
import { loadConfig } from "../../config/config.js";
import type { ModelMetadataProvider, Provider } from "../types.js";

// ── Credentials ───────────────────────────────────────────────────────────────

/** Anthropic API key from env or config; undefined when not configured. */
export function getAnthropicApiKey(): string | undefined {
  return (
    process.env.ANTHROPIC_API_KEY?.trim() ||
    loadConfig().provider.anthropic?.apiKey?.trim()
  );
}

export function getAnthropic() {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    throw new Error(
      "Anthropic is not configured — set ANTHROPIC_API_KEY (env or ~/.orin/config.json) "
      + "or run /providers configure anthropic",
    );
  }
  return createAnthropic({ apiKey });
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
  const apiKey = getAnthropicApiKey();
  if (!apiKey) return {};
  return { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } };
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
  authStrategy: "api-key",
  configFields: [
    {
      key: "apiKey",
      label: "Anthropic API key",
      secret: true,
      envVar: "ANTHROPIC_API_KEY",
    },
  ],
  isConfigured() {
    return Boolean(getAnthropicApiKey());
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
