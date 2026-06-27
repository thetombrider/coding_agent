import { activeProviderId, getProvider, resolveActiveProvider, resolvePickerModels } from "../provider/registry.js";
import { modelLikelySupported } from "../provider/picker-models.js";
import { loadConfig, type ModelSlot } from "./config.js";
import type { AgentPreset } from "../agent/presets.js";

const IMPLEMENT_BUILTIN = "moonshotai/kimi-k2.7-code";

/** Curated model ids for the `/model` picker for the given (or active) provider. */
export function pickerModelsForProvider(providerId?: string): readonly string[] {
  return resolvePickerModels(providerId);
}

function readSlotPin(providerId: string, slot: ModelSlot): string | undefined {
  const pin = loadConfig().models.providers?.[providerId]?.[slot]?.trim();
  return pin || undefined;
}

/**
 * Resolve the model for a provider slot: config pin when supported, otherwise
 * bundled `defaultSlots` or runtime rules (review → main, implement → Kimi → main).
 */
export function resolveProviderSlot(providerId: string, slot: ModelSlot): string {
  const provider = getProvider(providerId) ?? resolveActiveProvider();
  const pin = readSlotPin(providerId, slot);
  if (pin && modelLikelySupported(provider, pin)) return pin;

  switch (slot) {
    case "main":
      return provider.defaultSlots.main;
    case "explore":
      return provider.defaultSlots.explore;
    case "delegate_read":
      return provider.defaultSlots.delegate_read;
    case "compaction":
      return provider.defaultSlots.compaction;
    case "review":
      return resolveProviderSlot(providerId, "main");
    case "implement":
      if (modelLikelySupported(provider, IMPLEMENT_BUILTIN)) return IMPLEMENT_BUILTIN;
      return resolveProviderSlot(providerId, "main");
  }
}

const PRESET_SLOTS: Record<AgentPreset, ModelSlot> = {
  explore: "explore",
  review: "review",
  implement: "implement",
};

/** Pick the model a subagent preset should run on (live-resolved from config + defaults). */
export function resolvePresetModel(agent: AgentPreset, providerId?: string): string {
  const id = providerId ?? activeProviderId();
  return resolveProviderSlot(id, PRESET_SLOTS[agent]);
}
