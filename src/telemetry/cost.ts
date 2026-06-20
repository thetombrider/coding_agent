import type { ModelPricing } from "../config/config.js";
import type { Usage } from "../provider/types.js";

/** Full cost decomposition for a single LLM call. */
export interface CostBreakdown {
  model: string;
  usage: Usage;
  /** Total USD cost, or `null` when no pricing matched the model. */
  costUsd: number | null;
  /** True when pricing lookup failed — token counts are still populated. */
  pricingMissing: boolean;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
}

/**
 * Candidate pricing keys for a model, most specific first: the exact id, an
 * optional `providerId/`-prefixed form, then provider-prefix-stripped suffixes
 * (`a/b/c` → `b/c` → `c`) so an OpenRouter-style `openrouter/anthropic/x` id
 * still resolves a bare `anthropic/x` pricing entry.
 */
function pricingCandidates(model: string, providerId?: string): string[] {
  const candidates: string[] = [];
  const add = (key: string) => {
    if (key && !candidates.includes(key)) candidates.push(key);
  };
  add(model);
  if (providerId) add(`${providerId}/${model}`);
  const parts = model.split("/");
  for (let i = 1; i < parts.length; i++) add(parts.slice(i).join("/"));
  return candidates;
}

/** Resolve static config pricing for a model id (most specific key wins). */
export function resolveModelPricing(
  model: string,
  pricing: Record<string, ModelPricing>,
  providerId?: string,
): ModelPricing | undefined {
  for (const key of pricingCandidates(model, providerId)) {
    const found = pricing[key];
    if (found) return found;
  }
  return undefined;
}

/**
 * Compute the USD cost of a call from its token usage and the model's pricing.
 * Pricing rates are per-million tokens; `cacheRead`/`cacheWrite` fall back to
 * the input rate when no dedicated rate is configured. Unknown models yield
 * `costUsd: null` + `pricingMissing: true` while keeping the token counts.
 */
export function calcCost(
  model: string,
  usage: Usage,
  pricing: Record<string, ModelPricing>,
  providerId?: string,
): CostBreakdown {
  const found = resolveModelPricing(model, pricing, providerId);

  if (!found) {
    return {
      model,
      usage,
      costUsd: null,
      pricingMissing: true,
      inputCostUsd: 0,
      outputCostUsd: 0,
      cacheReadCostUsd: 0,
      cacheWriteCostUsd: 0,
    };
  }

  const cacheReadRate = found.cacheReadPerM ?? found.inputPerM;
  const cacheWriteRate = found.cacheWritePerM ?? found.inputPerM;

  const inputCostUsd = (usage.input * found.inputPerM) / 1_000_000;
  const outputCostUsd = (usage.output * found.outputPerM) / 1_000_000;
  const cacheReadCostUsd = ((usage.cacheRead ?? 0) * cacheReadRate) / 1_000_000;
  const cacheWriteCostUsd = ((usage.cacheWrite ?? 0) * cacheWriteRate) / 1_000_000;

  return {
    model,
    usage,
    costUsd: inputCostUsd + outputCostUsd + cacheReadCostUsd + cacheWriteCostUsd,
    pricingMissing: false,
    inputCostUsd,
    outputCostUsd,
    cacheReadCostUsd,
    cacheWriteCostUsd,
  };
}

/** AI SDK usage shape — a loose subset of what `streamText`/`generateText` return. */
export interface AiSdkUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

/**
 * Adapt the AI SDK's usage object to our internal `Usage`. Used by the
 * cheap-model side path (issue 3/8), which calls `generateText` directly and
 * therefore never produces an `assistant_message` event.
 */
export function aiSdkUsageToUsage(usage: AiSdkUsage): Usage {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens;
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: usage.totalTokens ?? input + output,
  };
}
