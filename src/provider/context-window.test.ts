import { afterEach, describe, expect, it, vi } from "vitest";
import { getContextWindow, MODEL_METADATA_PROVIDERS } from "./context-window.js";
import { resetOpenRouterModelsCache } from "./providers/openrouter.js";

const SINGLE_MODEL = {
  data: {
    id: "anthropic/claude-sonnet-4",
    canonical_slug: "anthropic/claude-sonnet-4",
    context_length: 200000,
    top_provider: { context_length: 200000 },
  },
};

function mockFetch(handlers: Record<string, { ok?: boolean; status?: number; body: unknown }>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const handler = Object.entries(handlers).find(([pattern]) => url.includes(pattern))?.[1];
    if (!handler) {
      return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
    }
    const ok = handler.ok ?? true;
    const status = handler.status ?? (ok ? 200 : 500);
    return { ok, status, statusText: ok ? "OK" : "Error", json: async () => handler.body };
  }) as unknown as typeof fetch;
}

describe("getContextWindow", () => {
  afterEach(() => {
    resetOpenRouterModelsCache();
    vi.unstubAllGlobals();
  });

  it("prefers the provider catalog over config defaults", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ "/api/v1/model/anthropic/claude-sonnet-4": { body: SINGLE_MODEL } }),
    );
    await expect(getContextWindow("anthropic/claude-sonnet-4")).resolves.toBe(200000);
  });

  it("falls back to config when the provider catalog misses", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "/api/v1/model/moonshotai/kimi-k2.7-code": { ok: false, status: 404, body: {} },
        "/api/v1/models": { body: { data: [] } },
      }),
    );
    await expect(getContextWindow("moonshotai/kimi-k2.7-code")).resolves.toBe(131072);
  });

  it("falls back to config when the provider catalog fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, statusText: "error" })),
    );
    await expect(getContextWindow("deepseek/deepseek-v4-flash")).resolves.toBe(64000);
  });

  it("uses the default when provider and config both miss", async () => {
    vi.stubGlobal("fetch", mockFetch({ "/api/v1/models": { body: { data: [] } } }));
    await expect(getContextWindow("faux:test")).resolves.toBe(32000);
  });

  it("registers OpenRouter as a metadata provider", () => {
    expect(MODEL_METADATA_PROVIDERS.some((provider) => provider.id === "openrouter")).toBe(true);
  });
});
