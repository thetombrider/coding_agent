import { activeProviderId, getProvider, resolveActiveProvider, resolvePickerModels } from "../provider/registry.js";
import { modelLikelySupported } from "../provider/picker-models.js";
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

function resolveDefaultForProvider(
  tier: "main" | "cheap",
  providerId?: string,
): string {
  const provider = getProvider(providerId ?? activeProviderId()) ?? resolveActiveProvider();
  const cfg = loadConfig();
  const global = tier === "main" ? cfg.models.main : cfg.models.cheap;
  const lastUsed = cfg.models.lastUsed?.[provider.id]?.[tier];
  const bundled = provider.defaultModels[tier];

  if (modelLikelySupported(provider, global)) return global;
  if (lastUsed && modelLikelySupported(provider, lastUsed)) return lastUsed;
  return bundled;
}

/** Load model defaults — config file first, then env var overrides. */
export function loadModelConfig(): ModelConfig {
  const cfg = loadConfig();
  return { main: cfg.models.main, cheap: cfg.models.cheap };
}

export function defaultMainModel(providerId?: string): string {
  return resolveDefaultForProvider("main", providerId);
}

export function defaultCheapModel(providerId?: string): string {
  return resolveDefaultForProvider("cheap", providerId);
}
