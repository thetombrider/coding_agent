import { createOpenRouter } from "@openrouter/ai-sdk-provider";

const DEFAULT_MAIN_MODEL = "anthropic/claude-sonnet-4";
const DEFAULT_CHEAP_MODEL = "google/gemini-2.5-flash-lite";

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

export function defaultMainModel(): string {
  return process.env.MINICODER_MODEL ?? DEFAULT_MAIN_MODEL;
}

export function defaultCheapModel(): string {
  return process.env.MINICODER_CHEAP_MODEL ?? DEFAULT_CHEAP_MODEL;
}
