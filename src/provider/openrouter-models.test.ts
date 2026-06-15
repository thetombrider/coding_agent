import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadOpenRouterModelsCatalog,
  lookupOpenRouterContextWindow,
  resetOpenRouterModelsCache,
} from "./openrouter-models.js";

const SAMPLE_MODELS = {
  data: [
    {
      id: "anthropic/claude-sonnet-4",
      canonical_slug: "anthropic/claude-sonnet-4",
      context_length: 200000,
      top_provider: { context_length: 200000 },
    },
    {
      id: "deepseek/deepseek-v4-flash",
      canonical_slug: "deepseek/deepseek-v4-flash",
      context_length: 64000,
      top_provider: { context_length: 64000 },
    },
  ],
};

function mockFetch(body: unknown, ok = true): typeof fetch {
  return vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Internal Server Error",
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("openrouter-models", () => {
  afterEach(() => {
    resetOpenRouterModelsCache();
  });

  it("loads and caches model context windows", async () => {
    const fetchImpl = mockFetch(SAMPLE_MODELS);
    const first = await loadOpenRouterModelsCatalog(fetchImpl);
    const second = await loadOpenRouterModelsCatalog(fetchImpl);

    expect(first.get("anthropic/claude-sonnet-4")).toBe(200000);
    expect(second.get("deepseek/deepseek-v4-flash")).toBe(64000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("looks up models by id and strips routing suffixes", async () => {
    const fetchImpl = mockFetch(SAMPLE_MODELS);
    await expect(
      lookupOpenRouterContextWindow("anthropic/claude-sonnet-4:nitro", fetchImpl),
    ).resolves.toBe(200000);
  });

  it("returns undefined for unknown models", async () => {
    const fetchImpl = mockFetch(SAMPLE_MODELS);
    await expect(lookupOpenRouterContextWindow("unknown/model", fetchImpl)).resolves.toBeUndefined();
  });
});
