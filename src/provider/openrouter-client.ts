/**
 * Shared OpenRouter primitives: API-key resolution, AI SDK client factory, and
 * model-id normalization. This is the single OpenRouter implementation; the
 * `providers/openrouter.ts` Provider adapter, `openrouter-models.ts`, and
 * `prompt-cache.ts` all build on these — there is no duplicate backend.
 */
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { loadConfig } from "../config/config.js";

/** OpenRouter API key from env or config; undefined when not configured. */
export function getOpenRouterApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY?.trim() || loadConfig().provider.openrouter?.apiKey;
}

export function getOpenRouter() {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set (env var or ~/.orin/config.json)");
  }
  return createOpenRouter({ apiKey });
}

/** Resolve an OpenRouter model id (strip optional `openrouter:` prefix). */
export function resolveOpenRouterModelId(modelId: string): string {
  return modelId.startsWith("openrouter:")
    ? modelId.slice("openrouter:".length)
    : modelId;
}
