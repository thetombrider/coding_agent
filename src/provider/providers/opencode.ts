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
  lookupOpenAiCompatibleContextWindow,
  listOpenAiCompatibleModelIds,
  type OpenAiCompatibleProviderConfig,
} from "../openai-compatible.js";
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
  "kimi-k2.7",
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
  "kimi-k2.7",
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
  getContextWindow(modelId) {
    return lookupOpenAiCompatibleContextWindow(GO_META_CFG, modelId);
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
    main: "kimi-k2.7",
    explore: "deepseek-v4-flash",
    delegate_read: "deepseek-v4-flash",
    compaction: "deepseek-v4-flash",
  },
};

// ── Opencode Zen ──────────────────────────────────────────────────────────────

/** Curated picker list for Zen; full catalog discoverable via /models endpoint. */
export const OPENCODE_ZEN_PICKER_MODELS = [
  "kimi-k2",
  "kimi-k2-thinking",
  "qwen3-coder",
  "claude-sonnet-4-5",
  "claude-opus-4-5",
  "gpt-5.1-codex",
  "gpt-5.2-codex",
  "grok-code",
  "gemini-3-flash",
  "glm-4.7-free",
] as const;

/** Opencode Zen — pay-as-you-go curated model gateway (fully OpenAI-compatible). */
export const opencodeZenProvider = createOpenAiCompatibleProvider({
  id: "opencode-zen",
  displayName: "Opencode Zen",
  configSection: "opencode",
  baseURL: "https://opencode.ai/zen/v1",
  pickerModels: OPENCODE_ZEN_PICKER_MODELS,
  defaultSlots: {
    main: "kimi-k2",
    explore: "glm-4.7-free",
    delegate_read: "glm-4.7-free",
    compaction: "glm-4.7-free",
  },
});
