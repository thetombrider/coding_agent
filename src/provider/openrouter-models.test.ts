import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadOpenRouterModelsCatalog,
  lookupOpenRouterContextWindow,
  openRouterModelLookupUrl,
  resetOpenRouterModelsCache,
} from "./openrouter-models.js";

const SINGLE_MODEL = {
  data: {
    id: "anthropic/claude-sonnet-4",
    canonical_slug: "anthropic/claude-sonnet-4",
    context_length: 200000,
    top_provider: { context_length: 200000 },
  },
};

const SAMPLE_CATALOG = {
  data: [
    SINGLE_MODEL.data,
    {
      id: "deepseek/deepseek-v4-flash",
      canonical_slug: "deepseek/deepseek-v4-flash",
      context_length: 64000,
      top_provider: { context_length: 64000 },
    },
  ],
};

function mockFetch(handlers: Record<string, { ok?: boolean; status?: number; body: unknown }>) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    const handler = Object.entries(handlers).find(([pattern]) => url.includes(pattern))?.[1];
    if (!handler) {
      return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
    }
    const ok = handler.ok ?? true;
    const status = handler.status ?? (ok ? 200 : 500);
    return {
      ok,
      status,
      statusText: ok ? "OK" : "Error",
      json: async () => handler.body,
    };
  }) as unknown as typeof fetch;
}

describe("openrouter-models", () => {
  afterEach(() => {
    resetOpenRouterModelsCache();
  });

  it("builds single-model lookup URLs per OpenRouter docs", () => {
    expect(openRouterModelLookupUrl("anthropic/claude-sonnet-4")).toBe(
      "https://openrouter.ai/api/v1/model/anthropic/claude-sonnet-4",
    );
    expect(openRouterModelLookupUrl("anthropic/claude-sonnet-4:nitro")).toBe(
      "https://openrouter.ai/api/v1/model/anthropic/claude-sonnet-4:nitro",
    );
  });

  it("uses single-model lookup before downloading the full catalog", async () => {
    const fetchImpl = mockFetch({
      "/api/v1/model/anthropic/claude-sonnet-4": { body: SINGLE_MODEL },
    });

    await expect(lookupOpenRouterContextWindow("anthropic/claude-sonnet-4", fetchImpl, "sk-test")).resolves.toBe(
      200000,
    );

    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(calls[0]?.[0])).toContain("/api/v1/model/anthropic/claude-sonnet-4");
    expect(calls[0]?.[1]).toEqual({
      headers: { Authorization: "Bearer sk-test" },
    });
  });

  it("falls back to the catalog when single-model lookup misses", async () => {
    const fetchImpl = mockFetch({
      "/api/v1/model/unknown/model": { ok: false, status: 404, body: {} },
      "/api/v1/models": { body: SAMPLE_CATALOG },
    });

    await expect(lookupOpenRouterContextWindow("unknown/model", fetchImpl)).resolves.toBeUndefined();
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(calls[1]?.[0])).toContain("/api/v1/models");
  });

  it("loads and caches the full catalog", async () => {
    const fetchImpl = mockFetch({ "/api/v1/models": { body: SAMPLE_CATALOG } });
    const first = await loadOpenRouterModelsCatalog(fetchImpl, "sk-test");
    const second = await loadOpenRouterModelsCatalog(fetchImpl, "sk-test");

    expect(first.get("deepseek/deepseek-v4-flash")).toBe(64000);
    expect(second.get("anthropic/claude-sonnet-4")).toBe(200000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("tries stripped routing suffixes on single-model lookup", async () => {
    const fetchImpl = mockFetch({
      "/api/v1/model/anthropic/claude-sonnet-4:nitro": { body: SINGLE_MODEL },
    });

    await expect(
      lookupOpenRouterContextWindow("anthropic/claude-sonnet-4:nitro", fetchImpl),
    ).resolves.toBe(200000);
  });
});
