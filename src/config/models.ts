import { activeProviderId, getProvider, resolveActiveProvider, resolvePickerModels } from "../provider/registry.js";
import { modelLikelySupported } from "../provider/picker-models.js";
import { loadConfig } from "./config.js";
import type { AgentPreset } from "../agent/presets.js";

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

/** Tier a subagent preset runs on by default when no specific model applies. */
const ROLE_TIER_DEFAULTS: Record<AgentPreset, "main" | "cheap"> = {
  explore: "cheap",
  review: "main",
  implement: "main",
};

/**
 * Built-in per-role model preferences. A role can prefer a specific model
 * (e.g. a code-tuned model for implementation) over its plain tier default.
 * Applied only when the active provider supports the id; otherwise the role
 * falls back to its tier default, so non-OpenRouter providers degrade cleanly.
 * `explore` intentionally has none — its cheap tier already resolves to the
 * configured cheap model (deepseek-v4-flash by default) and follows `/model`.
 */
const ROLE_MODEL_DEFAULTS: Partial<Record<AgentPreset, string>> = {
  implement: "moonshotai/kimi-k2.7-code",
};

/**
 * Pick the model a subagent preset should run on.
 * Precedence: explicit config override > built-in role model default > tier
 * default. The first two apply only when the active provider supports the id.
 * `hostMain`/`hostCheap` come from the live session so `/model` switches are honoured.
 */
export function resolvePresetModel(
  agent: AgentPreset,
  hostMain: string,
  hostCheap: string,
  providerId?: string,
): string {
  const cfg = loadConfig();
  const override = cfg.models.roles?.[agent]?.trim();
  const builtin = ROLE_MODEL_DEFAULTS[agent];
  if (override || builtin) {
    const provider = getProvider(providerId ?? activeProviderId()) ?? resolveActiveProvider();
    // Explicit config override wins when the provider supports it.
    if (override && modelLikelySupported(provider, override)) return override;
    // Otherwise prefer the role's built-in model when the provider supports it.
    if (builtin && modelLikelySupported(provider, builtin)) return builtin;
    // Fall through to the tier default for unsupported ids.
  }
  return ROLE_TIER_DEFAULTS[agent] === "cheap" ? hostCheap : hostMain;
}
