import { describe, expect, it } from "vitest";
import type { ModelPricing } from "../config/config.js";
import { aiSdkUsageToUsage, calcCost, resolveModelPricing } from "./cost.js";

const pricing: Record<string, ModelPricing> = {
  "anthropic/claude-opus-4.8": { inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheWritePerM: 18.75 },
  // No dedicated cache rates — should fall back to the input rate.
  "deepseek/deepseek-v4-flash": { inputPerM: 0.14, outputPerM: 0.28 },
};

describe("calcCost", () => {
  it("computes cost for a known model with explicit cache rates", () => {
    const result = calcCost(
      "anthropic/claude-opus-4.8",
      { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, totalTokens: 4_000_000 },
      pricing,
    );

    expect(result.pricingMissing).toBe(false);
    expect(result.inputCostUsd).toBeCloseTo(15);
    expect(result.outputCostUsd).toBeCloseTo(75);
    expect(result.cacheReadCostUsd).toBeCloseTo(1.5);
    expect(result.cacheWriteCostUsd).toBeCloseTo(18.75);
    expect(result.costUsd).toBeCloseTo(15 + 75 + 1.5 + 18.75);
  });

  it("falls back to the input rate when cache rates are absent", () => {
    const result = calcCost(
      "deepseek/deepseek-v4-flash",
      { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000, totalTokens: 2_000_000 },
      pricing,
    );

    // Both cache reads and writes priced at the 0.14 input rate.
    expect(result.cacheReadCostUsd).toBeCloseTo(0.14);
    expect(result.cacheWriteCostUsd).toBeCloseTo(0.14);
    expect(result.costUsd).toBeCloseTo(0.28);
  });

  it("returns pricingMissing for an unknown model but keeps token counts", () => {
    const usage = { input: 100, output: 50, totalTokens: 150 };
    const result = calcCost("mystery/model-x", usage, pricing);

    expect(result.pricingMissing).toBe(true);
    expect(result.costUsd).toBeNull();
    expect(result.usage).toEqual(usage);
  });

  it("resolves pricing after stripping a provider prefix", () => {
    const result = calcCost("openrouter/anthropic/claude-opus-4.8", { input: 1_000_000, output: 0, totalTokens: 1_000_000 }, pricing);
    expect(result.pricingMissing).toBe(false);
    expect(result.costUsd).toBeCloseTo(15);
  });
});

describe("resolveModelPricing", () => {
  it("returns the first matching pricing key", () => {
    expect(resolveModelPricing("anthropic/claude-opus-4.8", pricing)).toEqual(pricing["anthropic/claude-opus-4.8"]);
  });

  it("resolves via provider-prefixed and stripped suffix keys", () => {
    expect(resolveModelPricing("openrouter/anthropic/claude-opus-4.8", pricing, "openrouter")).toEqual(
      pricing["anthropic/claude-opus-4.8"],
    );
  });

  it("returns undefined for unknown models", () => {
    expect(resolveModelPricing("mystery/model-x", pricing)).toBeUndefined();
  });
});

describe("aiSdkUsageToUsage", () => {
  it("maps AI SDK fields including cache details", () => {
    const usage = aiSdkUsageToUsage({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      inputTokenDetails: { cacheReadTokens: 80, cacheWriteTokens: 10 },
    });
    expect(usage).toEqual({ input: 120, output: 30, cacheRead: 80, cacheWrite: 10, totalTokens: 150 });
  });

  it("defaults missing fields and derives totalTokens", () => {
    const usage = aiSdkUsageToUsage({ inputTokens: 10, outputTokens: 5 });
    expect(usage).toEqual({ input: 10, output: 5, cacheRead: undefined, cacheWrite: undefined, totalTokens: 15 });
  });

  it("reads a top-level cachedInputTokens fallback", () => {
    const usage = aiSdkUsageToUsage({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 7 });
    expect(usage.cacheRead).toBe(7);
  });
});
