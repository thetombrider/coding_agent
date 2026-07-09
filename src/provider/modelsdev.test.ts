import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadModelsDevCatalog,
  lookupModelsDevContextWindow,
  MODELSDEV_PROVIDER_ID_MAP,
  resetModelsDevCache,
} from "./modelsdev.js";

const CATALOG_TTL_MS = 60 * 60 * 1000;

const SAMPLE_CATALOG = {
  "regolo-ai": {
    id: "regolo-ai",
    name: "Regolo",
    models: {
      "llama-3.3-70b-instruct": { id: "llama-3.3-70b-instruct", limit: { context: 128000, output: 16384 } },
      "qwen3-coder-next": { id: "qwen3-coder-next", limit: { context: 262144, output: 16384 } },
      "no-context-model": { id: "no-context-model", limit: { context: 0, output: 16384 } },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5.5": { id: "gpt-5.5", limit: { context: 1050000, output: 128000 } },
      "gpt-5.4-mini": { id: "gpt-5.4-mini", limit: { context: 400000, output: 128000 } },
    },
  },
  opencode: {
    id: "opencode",
    name: "OpenCode Zen",
    models: {
      "claude-sonnet-4-5": { id: "claude-sonnet-4-5", limit: { context: 1000000, output: 64000 } },
      "deepseek-v4-flash": { id: "deepseek-v4-flash", limit: { context: 1000000, output: 384000 } },
    },
  },
  "opencode-go": {
    id: "opencode-go",
    name: "OpenCode Go",
    models: {
      "kimi-k2.7-code": { id: "kimi-k2.7-code", limit: { context: 262144, output: 262144 } },
    },
  },
};

function mockFetch(
  handlers: Record<string, { status?: number; etag?: string; body?: unknown }>,
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const handler = Object.entries(handlers).find(([pattern]) => url.includes(pattern))?.[1];
    if (!handler) {
      return { ok: false, status: 404, statusText: "Not Found", headers: { get: () => null }, json: async () => ({}) };
    }
    const status = handler.status ?? 200;
    const ok = status >= 200 && status < 300;
    return {
      ok,
      status,
      statusText: ok ? "OK" : "Error",
      headers: {
        get: (name: string) => (name.toLowerCase() === "etag" ? handler.etag ?? null : null),
      },
      json: async () => handler.body ?? {},
    };
  }) as unknown as typeof fetch;
}

describe("models.dev helper", () => {
  beforeEach(() => {
    resetModelsDevCache();
  });

  afterEach(() => {
    resetModelsDevCache();
  });

  describe("loadModelsDevCatalog", () => {
    it("fetches and caches the catalog with TTL", async () => {
      const fetchImpl = mockFetch({ "/api.json": { body: SAMPLE_CATALOG, etag: "W/abc" } });
      const first = await loadModelsDevCatalog(fetchImpl);
      const second = await loadModelsDevCatalog(fetchImpl);
      expect(first).toBe(SAMPLE_CATALOG);
      expect(second).toBe(SAMPLE_CATALOG);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const init = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
      expect(init.headers).not.toHaveProperty("If-None-Match");
    });

    it("reuses the cached body on 304 Not Modified and refreshes TTL", async () => {
      const fetchImpl = mockFetch({ "/api.json": { body: SAMPLE_CATALOG, etag: "W/abc" } });
      await loadModelsDevCatalog(fetchImpl);

      // Force the TTL to expire so the next call re-fetches.
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + CATALOG_TTL_MS + 1);

      // Second call returns 304 Not Modified.
      (fetchImpl as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
        ok: false,
        status: 304,
        statusText: "Not Modified",
        headers: { get: () => null },
        json: async () => ({}),
      }));

      const second = await loadModelsDevCatalog(fetchImpl);
      expect(second).toBe(SAMPLE_CATALOG);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const secondInit = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1]?.[1] as RequestInit;
      expect(secondInit.headers).toMatchObject({ "If-None-Match": "W/abc" });
      nowSpy.mockRestore();
    });

    it("throws on non-2xx, non-304 responses", async () => {
      const fetchImpl = mockFetch({ "/api.json": { status: 503 } });
      await expect(loadModelsDevCatalog(fetchImpl)).rejects.toThrow(/503/);
    });
  });

  describe("lookupModelsDevContextWindow", () => {
    it("maps our provider id to the models.dev id", async () => {
      const fetchImpl = mockFetch({ "/api.json": { body: SAMPLE_CATALOG } });
      await expect(lookupModelsDevContextWindow("regolo", "qwen3-coder-next", fetchImpl))
        .resolves.toBe(262144);
      await expect(lookupModelsDevContextWindow("openai", "gpt-5.5", fetchImpl))
        .resolves.toBe(1_050_000);
      await expect(lookupModelsDevContextWindow("opencode-zen", "claude-sonnet-4-5", fetchImpl))
        .resolves.toBe(1_000_000);
    });

    it("returns exact match for our model id", async () => {
      const fetchImpl = mockFetch({ "/api.json": { body: SAMPLE_CATALOG } });
      await expect(lookupModelsDevContextWindow("opencode-go", "kimi-k2.7-code", fetchImpl))
        .resolves.toBe(262144);
    });

    it("falls back to case-insensitive match (mixed-case id)", async () => {
      const fetchImpl = mockFetch({ "/api.json": { body: SAMPLE_CATALOG } });
      await expect(lookupModelsDevContextWindow("regolo", "Llama-3.3-70B-Instruct", fetchImpl))
        .resolves.toBe(128000);
    });

    it("returns undefined for unknown model ids", async () => {
      const fetchImpl = mockFetch({ "/api.json": { body: SAMPLE_CATALOG } });
      await expect(lookupModelsDevContextWindow("regolo", "nope", fetchImpl))
        .resolves.toBeUndefined();
    });

    it("skips entries with limit.context === 0 (non-LLM endpoints)", async () => {
      const fetchImpl = mockFetch({ "/api.json": { body: SAMPLE_CATALOG } });
      await expect(lookupModelsDevContextWindow("regolo", "no-context-model", fetchImpl))
        .resolves.toBeUndefined();
    });

    it("returns undefined when the fetch fails (never throws)", async () => {
      const fetchImpl = mockFetch({ "/api.json": { status: 500 } });
      await expect(lookupModelsDevContextWindow("regolo", "x", fetchImpl))
        .resolves.toBeUndefined();
    });

    it("returns undefined for unknown provider ids (no map entry)", async () => {
      const fetchImpl = mockFetch({ "/api.json": { body: SAMPLE_CATALOG } });
      await expect(lookupModelsDevContextWindow("mystery-provider", "x", fetchImpl))
        .resolves.toBeUndefined();
    });
  });

  describe("MODELSDEV_PROVIDER_ID_MAP", () => {
    it("maps the known mismatches", () => {
      expect(MODELSDEV_PROVIDER_ID_MAP.regolo).toBe("regolo-ai");
      expect(MODELSDEV_PROVIDER_ID_MAP["opencode-zen"]).toBe("opencode");
    });

    it("passes through matching ids", () => {
      expect(MODELSDEV_PROVIDER_ID_MAP.openrouter).toBe("openrouter");
      expect(MODELSDEV_PROVIDER_ID_MAP.openai).toBe("openai");
      expect(MODELSDEV_PROVIDER_ID_MAP.anthropic).toBe("anthropic");
      expect(MODELSDEV_PROVIDER_ID_MAP["opencode-go"]).toBe("opencode-go");
    });
  });
});
