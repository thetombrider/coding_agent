import { afterEach, describe, expect, it } from "vitest";
import type { ModelPricing } from "./config.js";
import { resolveDisplayModelPricing } from "./model-pricing.js";
import { loadOpenRouterModelsCatalog, resetOpenRouterModelsCache } from "../provider/providers/openrouter.js";

const pricing: Record<string, ModelPricing> = {
  "anthropic/claude-sonnet-4": { inputPerM: 3, outputPerM: 15 },
  "Llama-3.3-70B-Instruct": { inputPerM: 0.59, outputPerM: 0.79 },
};

describe("resolveDisplayModelPricing", () => {
  it("resolves config pricing for OpenRouter-style ids", () => {
    expect(resolveDisplayModelPricing("anthropic/claude-sonnet-4", "openrouter", pricing)).toEqual(
      pricing["anthropic/claude-sonnet-4"],
    );
  });

  it("maps Anthropic native ids via alias reverse lookup", () => {
    expect(resolveDisplayModelPricing("claude-sonnet-4-6", "anthropic", pricing)).toEqual(
      pricing["anthropic/claude-sonnet-4"],
    );
  });

  it("resolves Regolo native model ids from config", () => {
    expect(resolveDisplayModelPricing("Llama-3.3-70B-Instruct", "regolo", pricing)).toEqual(
      pricing["Llama-3.3-70B-Instruct"],
    );
  });

  it("returns undefined when no pricing is known", () => {
    expect(resolveDisplayModelPricing("unknown/model", "openrouter", pricing)).toBeUndefined();
  });

  it("prefers live OpenRouter catalog pricing over config", async () => {
    resetOpenRouterModelsCache();
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes("/api/v1/models")) {
        return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: [{
            id: "vendor/live-model",
            context_length: 1000,
            pricing: { prompt: "0.000001", completion: "0.000002" },
          }],
        }),
      };
    }) as typeof fetch;

    await loadOpenRouterModelsCatalog(fetchImpl, "sk-test");
    expect(resolveDisplayModelPricing("vendor/live-model", "openrouter", pricing)).toEqual({
      inputPerM: 1,
      outputPerM: 2,
    });
  });
});

afterEach(() => {
  resetOpenRouterModelsCache();
});
