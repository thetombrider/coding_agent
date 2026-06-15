import { loadConfig } from "./config.js";

export interface ModelConfig {
  /** Primary agent model — tool calling, reasoning, edits. */
  main: string;
  /** Cheap tier for delegate_read (Phase 3.5). */
  cheap: string;
}

/**
 * Curated main-model ids offered by the `/model` picker. Populated from
 * ~/.coding-agent/config.json (models.picker) at startup; falls back to
 * the built-in default list when no config file exists.
 */
export const KNOWN_MAIN_MODELS: readonly string[] = loadConfig().models.picker;

/** Load model defaults — config file first, then env var overrides. */
export function loadModelConfig(): ModelConfig {
  const cfg = loadConfig();
  return { main: cfg.models.main, cheap: cfg.models.cheap };
}

export function defaultMainModel(): string {
  return loadModelConfig().main;
}

export function defaultCheapModel(): string {
  return loadModelConfig().cheap;
}
