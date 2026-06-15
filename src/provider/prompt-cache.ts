import type { ModelMessage } from "ai";
import { resolveOpenRouterModelId } from "./openrouter.js";

const EPHEMERAL_CACHE = { type: "ephemeral" as const };

/** Anthropic-family models routed via OpenRouter support ephemeral prompt caching. */
export function supportsPromptCaching(modelId: string): boolean {
  const id = resolveOpenRouterModelId(modelId);
  return id.startsWith("anthropic/");
}

export function promptCacheProviderOptions(modelId: string) {
  if (!supportsPromptCaching(modelId)) return undefined;
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
