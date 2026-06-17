import { resolvePickerModels } from "../provider/registry.js";
import { loadConfig } from "./config.js";

export interface ModelConfig {
  /** Primary agent model — tool calling, reasoning, edits. */
  main: string;
  /** Cheap tier for delegate_read (Phase 3.5). */
  cheap: string;
}

/** Curated model ids for the `/model` picker for the given (or active) provider. */
export function pickerModelsForProvider(providerId?: string): readonly string[] {
  return resolvePickerModels(providerId);
}

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
