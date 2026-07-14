/**
 * Cloudflare AI Gateway — OpenAI-compatible gateway for multiple model providers.
 * https://developers.cloudflare.com/ai-gateway/usage/chat-completion/
 */
import { createOpenAI } from "@ai-sdk/openai";
import { loadConfig } from "../../config/config.js";
import { lookupModelsDevContextWindow } from "../modelsdev.js";
import type { ModelMetadataProvider, Provider, ProviderConfigField } from "../types.js";

const ID_PREFIX = "cloudflare:";
const DEFAULT_GATEWAY_ID = "default";

/** Curated Cloudflare AI Gateway models for the `/model` picker. */
export const CLOUDFLARE_PICKER_MODELS = [
  "anthropic/claude-sonnet-4.6",
  "openai/gpt-5.5",
  "openai/gpt-5.4-mini",
  "google-ai-studio/gemini-3.5-flash",
  "xai/grok-4.3",
] as const;

interface CloudflareCredentials {
  apiKey: string;
  accountId: string;
  gatewayId: string;
}

function getCloudflareSection() {
  return loadConfig().provider.cloudflare;
}

function resolveCredentials(): CloudflareCredentials | undefined {
  const section = getCloudflareSection();
  const apiKey = section?.apiKey?.trim();
  const accountId = section?.accountId?.trim();
  if (!apiKey || !accountId) return undefined;
  const gatewayId = section?.gatewayId?.trim() || DEFAULT_GATEWAY_ID;
  return { apiKey, accountId, gatewayId };
}

export function cloudflareBaseURL(accountId: string, gatewayId = DEFAULT_GATEWAY_ID): string {
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat`;
}

function normalizeModelId(modelId: string): string {
  return modelId.startsWith(ID_PREFIX) ? modelId.slice(ID_PREFIX.length) : modelId;
}

async function getContextWindow(modelId: string): Promise<number | undefined> {
  const normalized = normalizeModelId(modelId);
  const direct = await lookupModelsDevContextWindow("cloudflare", normalized);
  if (direct !== undefined) return direct;

  const slash = normalized.indexOf("/");
  if (slash === -1) return undefined;
  const upstreamProvider = normalized.slice(0, slash);
  const upstreamModel = normalized.slice(slash + 1);
  return lookupModelsDevContextWindow(upstreamProvider, upstreamModel);
}

const metadata: ModelMetadataProvider = {
  id: "cloudflare",
  supportsModel(modelId) {
    if (modelId.startsWith("faux:")) return false;
    if (modelId.startsWith(ID_PREFIX)) return true;
    return modelId.includes("/");
  },
  getContextWindow,
  async listModelIds() {
    return [...CLOUDFLARE_PICKER_MODELS];
  },
};

const CLOUDFLARE_CONFIG_FIELDS: readonly ProviderConfigField[] = [
  {
    key: "apiKey",
    label: "Cloudflare API token",
    secret: true,
  },
  {
    key: "accountId",
    label: "Cloudflare account ID",
  },
  {
    key: "gatewayId",
    label: "AI Gateway ID (default: default)",
  },
];

export const cloudflareProvider: Provider = {
  id: "cloudflare",
  displayName: "Cloudflare AI Gateway",
  authStrategy: "api-key",
  configFields: CLOUDFLARE_CONFIG_FIELDS,
  configSection: "cloudflare",

  isConfigured() {
    return Boolean(resolveCredentials());
  },

  normalizeModelId,

  languageModel(modelId) {
    const credentials = resolveCredentials();
    if (!credentials) {
      throw new Error(
        "Cloudflare AI Gateway is not configured — set provider.cloudflare.apiKey and "
        + "provider.cloudflare.accountId in ~/.orin/config.json or run /providers configure cloudflare",
      );
    }
    const client = createOpenAI({
      apiKey: credentials.apiKey,
      baseURL: cloudflareBaseURL(credentials.accountId, credentials.gatewayId),
    });
    return client.chat(normalizeModelId(modelId));
  },

  metadata,
  pickerModels: CLOUDFLARE_PICKER_MODELS,
  defaultSlots: {
    main: "anthropic/claude-sonnet-4.6",
    explore: "openai/gpt-5.4-mini",
    delegate_read: "openai/gpt-5.4-mini",
    compaction: "openai/gpt-5.4-mini",
  },
};
