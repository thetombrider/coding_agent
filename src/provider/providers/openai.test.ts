import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeOpenAiModelId, openaiProvider } from "./openai.js";
import { resetOpenAiCompatibleModelsCache } from "../openai-compatible.js";

function mockModelsFetch(body: unknown) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.openai.com/v1/models")) {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer sk-openai" });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        json: async () => body,
      };
    }
    return {
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: { get: () => null },
      json: async () => ({}),
    };
  }) as unknown as typeof fetch;
}

describe("openai provider", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevOpenAiKey: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    home = mkdtempSync(join(tmpdir(), "orin-openai-test-"));
    process.env.HOME = home;
    originalFetch = globalThis.fetch;
    resetOpenAiCompatibleModelsCache();
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAiKey;
    globalThis.fetch = originalFetch;
    resetOpenAiCompatibleModelsCache();
    rmSync(home, { recursive: true, force: true });
  });

  it("reports unconfigured without credentials", () => {
    expect(openaiProvider.isConfigured()).toBe(false);
  });

  it("reports configured when the config key is set", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { openai: { apiKey: "sk-openai" } } });
    vi.resetModules();
    const { openaiProvider: provider } = await import("./openai.js");
    expect(provider.isConfigured()).toBe(true);
  });

  it("reports configured when OPENAI_API_KEY env is set", async () => {
    process.env.OPENAI_API_KEY = " sk-env-key ";
    vi.resetModules();
    const { openaiProvider: provider } = await import("./openai.js");
    expect(provider.isConfigured()).toBe(true);
  });

  it("exposes api-key config fields", () => {
    expect(openaiProvider.configFields).toEqual([
      {
        key: "apiKey",
        label: "OpenAI API key",
        secret: true,
      },
    ]);
  });

  it("strips the openai: prefix", () => {
    expect(normalizeOpenAiModelId("openai:gpt-4o")).toBe("gpt-4o");
    expect(normalizeOpenAiModelId("gpt-4.1")).toBe("gpt-4.1");
  });

  it("maps legacy OpenRouter-style openai/slug ids", () => {
    expect(normalizeOpenAiModelId("openai/gpt-4o")).toBe("gpt-4o");
    expect(normalizeOpenAiModelId("openai/gpt-4.1-mini")).toBe("gpt-4.1-mini");
  });

  it("treats native and legacy openai ids as supported", () => {
    expect(openaiProvider.metadata.supportsModel("gpt-4o")).toBe(true);
    expect(openaiProvider.metadata.supportsModel("openai/gpt-4o")).toBe(true);
    expect(openaiProvider.metadata.supportsModel("anthropic/claude-sonnet-4")).toBe(false);
  });

  it("returns a language model handle when configured", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { openai: { apiKey: "sk-openai" } } });
    vi.resetModules();
    const { openaiProvider: provider } = await import("./openai.js");
    const model = provider.languageModel("openai/gpt-4o");
    expect(model).toBeDefined();
    expect(typeof model).toBe("object");
  });

  it("is registered in the provider registry", async () => {
    const { getProvider, providerSummaries } = await import("../registry.js");
    expect(getProvider("openai")?.id).toBe("openai");
    expect(providerSummaries().some((p) => p.id === "openai")).toBe(true);
  });

  it("resolves context windows from GET /v1/models", async () => {
    globalThis.fetch = mockModelsFetch({
      data: [
        { id: "gpt-4o", context_length: 128000 },
        { id: "gpt-4.1-mini", context_window: 32000 },
      ],
    });

    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { openai: { apiKey: "sk-openai" } } });
    vi.resetModules();
    const { openaiProvider: provider } = await import("./openai.js");

    await expect(provider.metadata.getContextWindow("gpt-4o")).resolves.toBe(128000);
    await expect(provider.metadata.getContextWindow("openai/gpt-4o")).resolves.toBe(128000);
    await expect(provider.metadata.getContextWindow("gpt-4.1-mini")).resolves.toBe(32000);
  });
});
