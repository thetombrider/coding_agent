/** OpenRouter model ids (provider/model format). UI can override these at runtime later. */
export interface ModelConfig {
  /** Primary agent model — tool calling, reasoning, edits. */
  main: string;
  /** Cheap tier for delegate_read (Phase 3.5). */
  cheap: string;
}

const FALLBACK_MAIN = "anthropic/claude-sonnet-4";
const FALLBACK_CHEAP = "deepseek/deepseek-v4-flash";

/**
 * Curated OpenRouter main-model ids offered by the `/model` picker. Any other
 * provider/model id can still be set explicitly; this is just the short list
 * for `/model` with no argument and numeric selection.
 */
export const KNOWN_MAIN_MODELS: readonly string[] = [
  "anthropic/claude-opus-4.8",
  "anthropic/claude-sonnet-4.6",
  "google/gemini-3.5-flash",
  "google/gemini-3.1-flash-lite",
  "deepseek/deepseek-v4-pro",
  "minimax/minimax-m3",
  "z-ai/glm-5.1",
  "inception/mercury-2",
  "arcee-ai/trinity-large-thinking",
  "mistralai/mistral-large-2512",
];

function envModel(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

/** Load model defaults from env. Single source of truth until TUI model picker ships. */
export function loadModelConfig(): ModelConfig {
  return {
    main: envModel("MINICODER_MODEL", FALLBACK_MAIN),
    cheap: defaultCheapModel(),
  };
}

export function defaultMainModel(): string {
  return loadModelConfig().main;
}

export function defaultCheapModel(): string {
  return envModel("MINICODER_CHEAP_MODEL", FALLBACK_CHEAP);
}
