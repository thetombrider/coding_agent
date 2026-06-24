import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import {
  anthropicProvider,
  markAnthropicCacheBreakpoints,
  resetAnthropicModelsCache,
  resolveAnthropicModelId,
} from "./anthropic.js";

describe("anthropic provider", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-anthropic-test-"));
    process.env.HOME = home;
    vi.resetModules();
    resetAnthropicModelsCache();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("reports unconfigured without credentials", () => {
    expect(anthropicProvider.isConfigured()).toBe(false);
  });

  it("reports configured when the API key is in config", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { anthropic: { apiKey: "sk-ant-test" } } });
    vi.resetModules();
    const { anthropicProvider: provider, getAnthropicApiKey } = await import("./anthropic.js");
    expect(provider.isConfigured()).toBe(true);
    expect(getAnthropicApiKey()).toBe("sk-ant-test");
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

  it("exposes api-key auth strategy and config fields", () => {
    expect(anthropicProvider.authStrategy).toBe("api-key");
    expect(anthropicProvider.configFields?.[0]).toMatchObject({
      key: "apiKey",
      label: "Anthropic API key",
      secret: true,
    });
  });

  it("returns a language model handle when configured via config", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { anthropic: { apiKey: "sk-ant-test" } } });
    vi.resetModules();
    const { anthropicProvider: provider } = await import("./anthropic.js");
    const model = provider.languageModel("claude-sonnet-4-6");
    expect(model).toBeDefined();
  });

  it("is registered in the provider registry", async () => {
    const { getProvider, providerSummaries } = await import("../registry.js");
    expect(getProvider("anthropic")?.id).toBe("anthropic");
    expect(providerSummaries().some((p) => p.id === "anthropic")).toBe(true);
  });

  it("resolves context window from catalog with config fallback", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { anthropic: { apiKey: "sk-ant-test" } } });
    vi.resetModules();
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

    const window = await lookupAnthropicContextWindow(
      "anthropic/claude-sonnet-4.6",
      mockFetch as typeof fetch,
    );
    expect(window).toBe(1_000_000);
  });
});
