import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import {
  buildStreamProviderOptions,
  getPromptCacheStrategy,
  loadOpenRouterModelsCatalog,
  lookupOpenRouterContextWindow,
  markPromptCacheBreakpoints,
  openRouterModelLookupUrl,
  promptCacheProviderOptions,
  requiresExplicitCacheBreakpoints,
  resetOpenRouterModelsCache,
  supportsPromptCaching,
} from "./openrouter.js";

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
    expect(calls[0]?.[1]).toMatchObject({
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
    // The suffixed lookup 404s, so resolution must fall back to the stripped id.
    const fetchImpl = mockFetch({
      "/api/v1/model/anthropic/claude-sonnet-4:nitro": { ok: false, status: 404, body: {} },
      "/api/v1/model/anthropic/claude-sonnet-4": { body: SINGLE_MODEL },
    });

    await expect(
      lookupOpenRouterContextWindow("anthropic/claude-sonnet-4:nitro", fetchImpl),
    ).resolves.toBe(200000);

    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.endsWith("claude-sonnet-4:nitro"))).toBe(true);
    expect(calls.some((u) => u.endsWith("/anthropic/claude-sonnet-4"))).toBe(true);
  });
});

describe("getPromptCacheStrategy", () => {
  it("classifies explicit-breakpoints models", () => {
    expect(getPromptCacheStrategy("anthropic/claude-sonnet-4")).toBe(
      "explicit-breakpoints",
    );
    expect(getPromptCacheStrategy("qwen/qwen3-coder-plus")).toBe(
      "explicit-breakpoints",
    );
    expect(getPromptCacheStrategy("qwen/qwen3.7-plus")).toBe(
      "explicit-breakpoints",
    );
    expect(getPromptCacheStrategy("deepseek/deepseek-v3.2")).toBe(
      "explicit-breakpoints",
    );
    expect(getPromptCacheStrategy("google/gemini-3.5-flash")).toBe(
      "explicit-breakpoints",
    );
  });

  it("classifies implicit-only models", () => {
    expect(getPromptCacheStrategy("deepseek/deepseek-v4-flash")).toBe(
      "implicit-only",
    );
    expect(getPromptCacheStrategy("minimax/minimax-m3")).toBe("implicit-only");
    expect(getPromptCacheStrategy("moonshotai/kimi-k2.7-code")).toBe(
      "implicit-only",
    );
    expect(getPromptCacheStrategy("openai/gpt-4o")).toBe("implicit-only");
    expect(getPromptCacheStrategy("x-ai/grok-3")).toBe("implicit-only");
  });

  it("excludes unsupported models and Qwen snapshots", () => {
    expect(getPromptCacheStrategy("mistralai/mistral-large-2512")).toBe("none");
    expect(getPromptCacheStrategy("qwen/qwen3.5-plus-02-15")).toBe("none");
    expect(getPromptCacheStrategy("qwen/qwen3.5-flash-02-23")).toBe("none");
  });
});

describe("supportsPromptCaching", () => {
  it("is true for explicit and implicit models", () => {
    expect(supportsPromptCaching("anthropic/claude-sonnet-4")).toBe(true);
    expect(supportsPromptCaching("deepseek/deepseek-v4-flash")).toBe(true);
    expect(supportsPromptCaching("openrouter:minimax/minimax-m3")).toBe(true);
  });

  it("is false for unsupported models", () => {
    expect(supportsPromptCaching("mistralai/mistral-large-2512")).toBe(false);
  });
});

describe("requiresExplicitCacheBreakpoints", () => {
  it("is true only for explicit-breakpoints models", () => {
    expect(requiresExplicitCacheBreakpoints("anthropic/claude-sonnet-4")).toBe(
      true,
    );
    expect(requiresExplicitCacheBreakpoints("google/gemini-3.5-flash")).toBe(
      true,
    );
    expect(requiresExplicitCacheBreakpoints("deepseek/deepseek-v4-flash")).toBe(
      false,
    );
    expect(requiresExplicitCacheBreakpoints("minimax/minimax-m3")).toBe(false);
  });
});

describe("promptCacheProviderOptions", () => {
  it("returns cache hints for explicit-breakpoints models", () => {
    expect(promptCacheProviderOptions("anthropic/claude-sonnet-4")).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(promptCacheProviderOptions("qwen/qwen3-max")).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  it("returns undefined for implicit-only models", () => {
    expect(promptCacheProviderOptions("deepseek/deepseek-v4-flash")).toBeUndefined();
    expect(promptCacheProviderOptions("minimax/minimax-m3")).toBeUndefined();
  });
});

describe("buildStreamProviderOptions", () => {
  it("includes session_id for OpenRouter sticky routing", () => {
    expect(buildStreamProviderOptions("deepseek/deepseek-v4-flash", "sess-abc")).toEqual({
      openrouter: { session_id: "sess-abc" },
    });
  });

  it("merges cache hints and session_id for explicit models", () => {
    expect(buildStreamProviderOptions("anthropic/claude-sonnet-4", "sess-abc")).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
      openrouter: { session_id: "sess-abc" },
    });
  });

  it("truncates session ids longer than 256 characters", () => {
    const longId = "x".repeat(300);
    const opts = buildStreamProviderOptions("deepseek/deepseek-v4-flash", longId);
    expect((opts?.openrouter as { session_id: string }).session_id).toHaveLength(256);
  });

  it("returns undefined when there is nothing to attach", () => {
    expect(buildStreamProviderOptions("mistralai/mistral-large-2512")).toBeUndefined();
  });
});

describe("markPromptCacheBreakpoints", () => {
  it("marks the penultimate message for explicit-breakpoints models", () => {
    const aiMessages: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: "second" },
    ];

    markPromptCacheBreakpoints(aiMessages, "google/gemini-3.5-flash");

    expect(aiMessages[0].providerOptions).toBeUndefined();
    expect(aiMessages[1].providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(aiMessages[2].providerOptions).toBeUndefined();
  });

  it("skips marking for implicit-only models", () => {
    const aiMessages: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: "second" },
    ];

    markPromptCacheBreakpoints(aiMessages, "deepseek/deepseek-v4-flash");

    for (const message of aiMessages) {
      expect(message.providerOptions).toBeUndefined();
    }
  });

  it("does nothing for single-message conversations", () => {
    const aiMessages: ModelMessage[] = [{ role: "user", content: "only" }];

    markPromptCacheBreakpoints(aiMessages, "anthropic/claude-sonnet-4");

    expect(aiMessages[0].providerOptions).toBeUndefined();
  });
});
