/** OpenRouter model ids (provider/model format). UI can override these at runtime later. */
export interface ModelConfig {
  /** Primary agent model — tool calling, reasoning, edits. */
  main: string;
  /** Cheap tier for delegate_read (Phase 3.5). */
  cheap: string;
}

const FALLBACK_MAIN = "anthropic/claude-sonnet-4";
const FALLBACK_CHEAP = "deepseek/deepseek-v4-flash";

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
