import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { resolveOpenRouterModelId } from "./openrouter-client.js";

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
