/**
 * Command Code provider — API gateway compatible with both OpenAI Chat
 * Completions and Anthropic Messages endpoints.
 *
 * https://commandcode.ai/docs/provider
 *
 * A single API key (stored in provider.command-code.apiKey) works for both
 * protocol formats. Anthropic models (claude-*) are routed through the
 * /messages endpoint via @ai-sdk/anthropic; all other models use the
 * /chat/completions endpoint via @ai-sdk/openai.
 *
 * Context windows are fetched live from the /v1/models endpoint, which
 * includes a `context_length` field for every model.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { loadConfig } from "../../config/config.js";
import {
  loadOpenAiCompatibleModelsCatalog,
  listOpenAiCompatibleModelIds,
  type OpenAiCompatibleProviderConfig,
} from "../openai-compatible.js";
import type { ModelMetadataProvider, Provider, ProviderConfigField } from "../types.js";

const BASE_URL = "https://api.commandcode.ai/provider/v1";
const ID_PREFIX = "command-code:";

/** Models served via the Anthropic Messages API (/messages). All others use /chat/completions. */
function isAnthropicModel(modelId: string): boolean {
  return modelId.startsWith("claude-");
}

/** Strip the optional id prefix. */
function normalizeModelId(modelId: string): string {
  return modelId.startsWith(ID_PREFIX) ? modelId.slice(ID_PREFIX.length) : modelId;
}

function getApiKey(): string | undefined {
  return loadConfig().provider["command-code"]?.apiKey?.trim() || undefined;
}

// ── Context window resolution ─────────────────────────────────────────────────

/** Minimal config needed by the shared OpenAI-compatible models catalog loader. */
const META_CFG: OpenAiCompatibleProviderConfig = {
  id: "command-code",
  displayName: "Command Code",
  configSection: "command-code",
  baseURL: BASE_URL,
  pickerModels: [],
  defaultSlots: { main: "", explore: "", delegate_read: "", compaction: "" },
};

const metadata: ModelMetadataProvider = {
  id: "command-code",
  supportsModel(modelId) {
    if (modelId.startsWith("faux:")) return false;
    if (modelId.startsWith(ID_PREFIX)) return true;
    return true; // Command Code serves any model id it recognizes
  },
  async getContextWindow(modelId) {
    const normalized = normalizeModelId(modelId);
    try {
      const catalog = await loadOpenAiCompatibleModelsCatalog(META_CFG);
      return catalog.get(normalized);
    } catch {
      return undefined;
    }
  },
  listModelIds() {
    return listOpenAiCompatibleModelIds(META_CFG);
  },
};

// ── Curated picker models ─────────────────────────────────────────────────────

export const COMMAND_CODE_PICKER_MODELS = [
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-fable-5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "moonshotai/Kimi-K2.7-Code",
  "moonshotai/Kimi-K2.6",
  "zai-org/GLM-5.2",
  "zai-org/GLM-5.2-Fast",
  "MiniMaxAI/MiniMax-M3",
  "xiaomi/mimo-v2.5-pro",
  "Qwen/Qwen3.7-Max",
  "google/gemini-3.5-flash",
  "xai/grok-4.5",
] as const;

// ── Config fields ─────────────────────────────────────────────────────────────

const CONFIG_FIELDS: readonly ProviderConfigField[] = [
  {
    key: "apiKey",
    label: "Command Code API key",
    secret: true,
  },
];

// ── Provider ──────────────────────────────────────────────────────────────────

export const commandCodeProvider: Provider = {
  id: "command-code",
  displayName: "Command Code",
  authStrategy: "api-key",
  configFields: CONFIG_FIELDS,
  configSection: "command-code",

  isConfigured() {
    return Boolean(getApiKey());
  },

  normalizeModelId(modelId) {
    return normalizeModelId(modelId);
  },

  languageModel(modelId): LanguageModel {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new Error(
        "Command Code is not configured — set provider.command-code.apiKey in ~/.orin/config.json "
        + "or run /providers configure command-code",
      );
    }

    const normalized = normalizeModelId(modelId);

    if (isAnthropicModel(normalized)) {
      return createAnthropic({
        apiKey,
        baseURL: BASE_URL,
      }).languageModel(normalized);
    }

    return createOpenAI({
      apiKey,
      baseURL: BASE_URL,
    }).chat(normalized);
  },

  metadata,
  pickerModels: COMMAND_CODE_PICKER_MODELS,
  defaultSlots: {
    main: "deepseek/deepseek-v4-flash",
    explore: "deepseek/deepseek-v4-flash",
    delegate_read: "deepseek/deepseek-v4-flash",
    compaction: "deepseek/deepseek-v4-flash",
  },
};
