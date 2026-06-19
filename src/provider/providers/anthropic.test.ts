import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import {
  anthropicProvider,
  getAnthropicApiKey,
  hasAnthropicOAuthTokens,
  markAnthropicCacheBreakpoints,
  resetAnthropicModelsCache,
  resolveAnthropicModelId,
  anthropicClientOptions,
  ANTHROPIC_OAUTH_BETA,
} from "./anthropic.js";

describe("anthropic provider", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevKey: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevKey = process.env.ANTHROPIC_API_KEY;
    home = mkdtempSync(join(tmpdir(), "orin-anthropic-test-"));
    process.env.HOME = home;
    delete process.env.ANTHROPIC_API_KEY;
    vi.resetModules();
    resetAnthropicModelsCache();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    rmSync(home, { recursive: true, force: true });
  });

  it("reports unconfigured without credentials", () => {
    expect(anthropicProvider.isConfigured()).toBe(false);
  });

  it("reports configured when the API key env var is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(anthropicProvider.isConfigured()).toBe(true);
    expect(getAnthropicApiKey()).toBe("sk-ant-test");
  });

  it("reports configured when OAuth tokens exist", async () => {
    const { saveProviderTokens } = await import("../oauth/tokens.js");
    saveProviderTokens("anthropic", {
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
      expiresAt: Date.now() + 3600_000,
    });
    expect(hasAnthropicOAuthTokens()).toBe(true);
    expect(anthropicProvider.isConfigured()).toBe(true);
  });

  it("prefers API key over OAuth tokens by default", async () => {
    const { saveProviderTokens } = await import("../oauth/tokens.js");
    saveProviderTokens("anthropic", { accessToken: "oauth-access", expiresAt: Date.now() + 3600_000 });
    process.env.ANTHROPIC_API_KEY = "sk-ant-priority";
    const { resolveAnthropicAuth } = await import("./anthropic.js");
    expect(resolveAnthropicAuth()?.kind).toBe("api-key");
  });

  it("prefers OAuth when preferredAuth is oauth and both credentials exist", async () => {
    const { saveProviderTokens } = await import("../oauth/tokens.js");
    const { saveConfig } = await import("../../config/config.js");
    const { resolveAnthropicAuth } = await import("./anthropic.js");
    saveProviderTokens("anthropic", {
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
      expiresAt: Date.now() + 3600_000,
    });
    process.env.ANTHROPIC_API_KEY = "sk-ant-priority";
    saveConfig({ provider: { anthropic: { preferredAuth: "oauth" } } });
    expect(resolveAnthropicAuth()?.kind).toBe("oauth");
  });

  it("uses Bearer transport and oauth beta header for OAuth tokens", async () => {
    const { resolveAnthropicAuth } = await import("./anthropic.js");
    expect(
      anthropicClientOptions({ kind: "oauth", accessToken: "sk-ant-oat01-test" }),
    ).toEqual({
      authToken: "sk-ant-oat01-test",
      headers: { "anthropic-beta": ANTHROPIC_OAUTH_BETA },
    });
    expect(anthropicClientOptions({ kind: "api-key", apiKey: "sk-ant-api03-test" })).toEqual({
      apiKey: "sk-ant-api03-test",
    });
    expect(resolveAnthropicAuth()).toBeUndefined();
  });

  it("prefers OAuth when preferredAuth is oauth even if access token expired", async () => {
    const { saveProviderTokens } = await import("../oauth/tokens.js");
    const { saveConfig } = await import("../../config/config.js");
    const { resolveAnthropicAuth } = await import("./anthropic.js");
    saveProviderTokens("anthropic", {
      accessToken: "expired-access",
      refreshToken: "oauth-refresh",
      expiresAt: Date.now() - 60_000,
    });
    process.env.ANTHROPIC_API_KEY = "sk-ant-priority";
    saveConfig({ provider: { anthropic: { preferredAuth: "oauth" } } });
    expect(resolveAnthropicAuth()?.kind).toBe("oauth");
  });

  it("resolves OAuth auth when access token expired but refresh token exists", async () => {
    const { saveProviderTokens } = await import("../oauth/tokens.js");
    const { resolveAnthropicAuth } = await import("./anthropic.js");
    saveProviderTokens("anthropic", {
      accessToken: "expired-access",
      refreshToken: "oauth-refresh",
      expiresAt: Date.now() - 60_000,
    });
    expect(resolveAnthropicAuth()?.kind).toBe("oauth");
  });

  it("normalizes OpenRouter-style and prefixed model ids", () => {
    expect(resolveAnthropicModelId("anthropic/claude-sonnet-4.6")).toBe("claude-sonnet-4-6");
    expect(resolveAnthropicModelId("anthropic:claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(resolveAnthropicModelId("claude-sonnet-4-20250514")).toBe("claude-sonnet-4-6");
    expect(resolveAnthropicModelId("claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("marks penultimate messages for prompt caching", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: [{ type: "text", text: "two" }] },
      { role: "user", content: "three" },
    ];
    markAnthropicCacheBreakpoints(messages);
    expect(messages[1]?.providerOptions).toMatchObject({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  it("exposes api-key-or-oauth auth strategy and config fields", () => {
    expect(anthropicProvider.authStrategy).toBe("api-key-or-oauth");
    expect(anthropicProvider.configFields?.[0]?.envVar).toBe("ANTHROPIC_API_KEY");
  });

  it("returns a language model handle when configured via API key", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const model = anthropicProvider.languageModel("claude-sonnet-4-6");
    expect(model).toBeDefined();
  });

  it("is registered in the provider registry", async () => {
    const { getProvider, providerSummaries } = await import("../registry.js");
    expect(getProvider("anthropic")?.id).toBe("anthropic");
    expect(providerSummaries().some((p) => p.id === "anthropic")).toBe(true);
  });

  it("resolves context window from catalog with config fallback", async () => {
    const { lookupAnthropicContextWindow } = await import("./anthropic.js");
    const mockFetch = vi.fn(async (url: string) => {
      if (url.includes("/v1/models")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "claude-sonnet-4-6", max_input_tokens: 1_000_000 }],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const window = await lookupAnthropicContextWindow(
      "anthropic/claude-sonnet-4.6",
      mockFetch as typeof fetch,
    );
    expect(window).toBe(1_000_000);
  });
});

describe("anthropic oauth exchange", () => {
  it("refreshes expired tokens via mock fetch", async () => {
    const { refreshAnthropicOAuthTokens } = await import("../oauth/anthropic-oauth.js");
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );

    const tokens = await refreshAnthropicOAuthTokens("old-refresh", mockFetch as typeof fetch);
    expect(tokens.accessToken).toBe("new-access");
    expect(tokens.refreshToken).toBe("new-refresh");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });
});
