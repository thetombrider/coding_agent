/**
 * Opencode providers — hosted model gateways from opencode.ai.
 *
 * Opencode Go  (`opencode-go`): flat-rate subscription ($10/month) serving 14
 *   open coding models over two protocols:
 *   • 8 models via OpenAI-compatible  /chat/completions  (@ai-sdk/openai)
 *   • 6 models via Anthropic Messages  /messages          (@ai-sdk/anthropic)
 *   Both share the same base URL and API key.
 *
 * Opencode Zen (`opencode-zen`): pay-as-you-go curated model gateway; fully
 *   OpenAI-compatible /chat/completions for all models.
 *
 * Both use a single API key stored in provider.opencode.apiKey in
 * ~/.orin/config.json.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { loadConfig } from "../../config/config.js";
import {
  createOpenAiCompatibleProvider,
  listOpenAiCompatibleModelIds,
  type OpenAiCompatibleProviderConfig,
} from "../openai-compatible.js";
import { lookupModelsDevContextWindow } from "../modelsdev.js";
import type { ModelMetadataProvider, Provider, ProviderConfigField } from "../types.js";

// ── Shared credentials ────────────────────────────────────────────────────────

function getOpencodeApiKey(): string | undefined {
  return loadConfig().provider.opencode?.apiKey?.trim();
}

// ── Opencode Go ───────────────────────────────────────────────────────────────

const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

/**
 * Go models served via the Anthropic Messages API (`/messages`).
 * All other Go models use the OpenAI-compatible `/chat/completions` path.
 */
const OPENCODE_GO_ANTHROPIC_MODELS = new Set([
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
]);

/** All 14 Go model ids (used for supportsModel and picker). */
const OPENCODE_GO_ALL_MODELS = new Set([
  // OpenAI-compatible (/chat/completions)
  "glm-5.2",
  "glm-5.1",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  // Anthropic-compatible (/messages)
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
]);

/** Curated picker list for Go: OpenAI-compat models first, then Anthropic-compat. */
export const OPENCODE_GO_PICKER_MODELS = [
  "kimi-k2.7-code",
  "kimi-k2.6",
  "glm-5.2",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "glm-5.1",
  "mimo-v2.5-pro",
  "mimo-v2.5",
  "minimax-m3",
  "minimax-m2.7",
  "qwen3.7-max",
  "qwen3.7-plus",
  "minimax-m2.5",
  "qwen3.6-plus",
] as const;

/**
 * Last-resort context-window fallback for the curated opencode picker models.
 * Used only when the models.dev catalog fetch fails (e.g. offline). Values
 * mirror what models.dev currently publishes; if a model id moves between
 * providers on their side, the catalog is the source of truth and this table
 * is purely a safety net so the agent still computes sensible compaction
 * thresholds.
 */
const OPENCODE_OFFLINE_CONTEXT_WINDOWS: Record<string, number> = {
  // Go tier (14 models)
  "glm-5.2": 1_000_000,
  "glm-5.1": 202_752,
  "kimi-k2.7-code": 262_144,
  "kimi-k2.6": 262_144,
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
  "mimo-v2.5-pro": 1_048_576,
  "mimo-v2.5": 1_000_000,
  "minimax-m3": 1_000_000,
  "minimax-m2.7": 204_800,
  "minimax-m2.5": 204_800,
  "qwen3.7-max": 1_000_000,
  "qwen3.7-plus": 1_000_000,
  "qwen3.6-plus": 1_000_000,
  // Zen tier picker (10 models)
  "claude-sonnet-4-5": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-opus-4-5": 200_000,
  "gpt-5.4": 1_050_000,
  "gpt-5.4-mini": 400_000,
  "grok-build-0.1": 256_000,
  "gemini-3-flash": 1_048_576,
  "deepseek-v4-flash-free": 200_000,
};

function opencodeOfflineContextWindow(modelId: string): number | undefined {
  return OPENCODE_OFFLINE_CONTEXT_WINDOWS[modelId];
}

// Minimal config object used to drive the OpenAI-compatible /models catalog for Go.
const GO_META_CFG: OpenAiCompatibleProviderConfig = {
  id: "opencode-go",
  displayName: "Opencode Go",
  configSection: "opencode",
  baseURL: OPENCODE_GO_BASE_URL,
  pickerModels: [],
  defaultSlots: { main: "", explore: "", delegate_read: "", compaction: "" },
};

const opencodeGoMetadata: ModelMetadataProvider = {
  id: "opencode-go",
  supportsModel(modelId) {
    if (modelId.startsWith("faux:")) return false;
    return OPENCODE_GO_ALL_MODELS.has(modelId);
  },
  async getContextWindow(modelId) {
    return (await lookupModelsDevContextWindow("opencode-go", modelId))
      ?? opencodeOfflineContextWindow(modelId);
  },
  listModelIds() {
    return listOpenAiCompatibleModelIds(GO_META_CFG);
  },
};

const OPENCODE_GO_CONFIG_FIELDS: readonly ProviderConfigField[] = [
  {
    key: "apiKey",
    label: "Opencode API key",
    secret: true,
  },
];

export const opencodeGoProvider: Provider = {
  id: "opencode-go",
  displayName: "Opencode Go",
  authStrategy: "api-key",
  configFields: OPENCODE_GO_CONFIG_FIELDS,
  configSection: "opencode",

  isConfigured() {
    return Boolean(getOpencodeApiKey());
  },

  normalizeModelId(modelId) {
    return modelId;
  },

  languageModel(modelId): LanguageModel {
    const apiKey = getOpencodeApiKey();
    if (!apiKey) {
      throw new Error(
        "Opencode is not configured — set provider.opencode.apiKey in ~/.orin/config.json "
        + "or run /providers configure opencode-go",
      );
    }
    if (OPENCODE_GO_ANTHROPIC_MODELS.has(modelId)) {
      return createAnthropic({ apiKey, baseURL: OPENCODE_GO_BASE_URL }).languageModel(modelId);
    }
    return createOpenAI({ apiKey, baseURL: OPENCODE_GO_BASE_URL }).chat(modelId);
  },

  metadata: opencodeGoMetadata,
  pickerModels: OPENCODE_GO_PICKER_MODELS,
  defaultSlots: {
    main: "kimi-k2.7-code",
    explore: "deepseek-v4-flash",
    delegate_read: "deepseek-v4-flash",
    compaction: "deepseek-v4-flash",
  },
};

// ── Opencode Zen ──────────────────────────────────────────────────────────────

/** Curated picker list for Zen; full catalog discoverable via /models endpoint. */
export const OPENCODE_ZEN_PICKER_MODELS = [
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "kimi-k2.6",
  "grok-build-0.1",
  "gemini-3-flash",
  "deepseek-v4-flash",
  "deepseek-v4-flash-free",
] as const;

/** Opencode Zen — pay-as-you-go curated model gateway (fully OpenAI-compatible). */
const opencodeZenBase = createOpenAiCompatibleProvider({
  id: "opencode-zen",
  displayName: "Opencode Zen",
  configSection: "opencode",
  baseURL: "https://opencode.ai/zen/v1",
  pickerModels: OPENCODE_ZEN_PICKER_MODELS,
  defaultSlots: {
    main: "kimi-k2.6",
    explore: "deepseek-v4-flash-free",
    delegate_read: "deepseek-v4-flash-free",
    compaction: "deepseek-v4-flash-free",
  },
});

/**
 * Zen inherits the OpenAI-compatible factory's metadata, but the opencode
 * `/v1/models` endpoint omits context windows — so we override the resolver
 * to consult models.dev first (provider id `opencode` in the catalog).
 * The curated offline table is the final safety net if the catalog is
 * unreachable.
 */
const originalZenGetContextWindow = opencodeZenBase.metadata.getContextWindow;
opencodeZenBase.metadata.getContextWindow = async (modelId) => {
  return (await lookupModelsDevContextWindow("opencode-zen", modelId))
    ?? opencodeOfflineContextWindow(modelId)
    ?? await originalZenGetContextWindow(modelId);
};

export const opencodeZenProvider: Provider = opencodeZenBase;
