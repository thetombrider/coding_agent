import type { ModelPricing } from "./config.js";
import { ANTHROPIC_MODEL_ALIASES } from "../provider/providers/anthropic.js";
import { lookupOpenRouterPricing } from "../provider/providers/openrouter.js";
import { resolveModelPricing } from "../telemetry/cost.js";

/**
 * Resolve display pricing for a picker model: live OpenRouter catalog when
 * available, then static config (with Anthropic alias reverse-lookup).
 */
export function resolveDisplayModelPricing(
  model: string,
  providerId: string,
  pricing: Record<string, ModelPricing>,
): ModelPricing | undefined {
  if (providerId === "openrouter") {
    const live = lookupOpenRouterPricing(model);
    if (live) return live;
  }

  const fromConfig = resolveModelPricing(model, pricing, providerId);
  if (fromConfig) return fromConfig;

  if (providerId === "anthropic") {
    for (const [alias, nativeId] of Object.entries(ANTHROPIC_MODEL_ALIASES)) {
      if (nativeId === model) {
        const viaAlias = resolveModelPricing(alias, pricing, providerId);
        if (viaAlias) return viaAlias;
      }
    }
  }

  return undefined;
}
