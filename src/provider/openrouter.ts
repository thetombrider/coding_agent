import { createOpenRouter } from "@openrouter/ai-sdk-provider";

export function getOpenRouter() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  return createOpenRouter({ apiKey });
}

/** Resolve an OpenRouter model id (strip optional `openrouter:` prefix). */
export function resolveOpenRouterModelId(modelId: string): string {
  return modelId.startsWith("openrouter:")
    ? modelId.slice("openrouter:".length)
    : modelId;
}
