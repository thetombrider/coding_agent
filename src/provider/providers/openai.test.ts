import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPENAI_PICKER_MODELS,
  isOpenAiProModel,
  isOpenAiReasoningModel,
  normalizeOpenAiModelId,
  openaiProvider,
  shouldUseOpenAiResponsesApi,
} from "./openai.js";
import { resetOpenAiCompatibleModelsCache } from "../openai-compatible.js";
import { resetModelsDevCache } from "../modelsdev.js";

function mockFetch(handlers: Record<string, { ok?: boolean; status?: number; body: unknown }>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const handler = Object.entries(handlers).find(([pattern]) => url.includes(pattern))?.[1];
    if (!handler) {
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: { get: () => null },
        json: async () => ({}),
      };
    }
    const ok = handler.ok ?? true;
    const status = handler.status ?? (ok ? 200 : 500);
    return {
      ok,
      status,
      statusText: ok ? "OK" : "Error",
      headers: { get: () => null },
      json: async () => handler.body,
    };
  }) as unknown as typeof fetch;
}

describe("openai provider", () => {
  let home: string;
  let prevHome: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-openai-test-"));
    process.env.HOME = home;
    originalFetch = globalThis.fetch;
    resetOpenAiCompatibleModelsCache();
    resetModelsDevCache();
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    globalThis.fetch = originalFetch;
    resetOpenAiCompatibleModelsCache();
    resetModelsDevCache();
    rmSync(home, { recursive: true, force: true });
  });

  it("lists current flagship models in the picker", () => {
    expect(OPENAI_PICKER_MODELS[0]).toBe("gpt-5.6");
    expect(OPENAI_PICKER_MODELS).toContain("gpt-5.6-terra");
    expect(OPENAI_PICKER_MODELS).toContain("gpt-5.6-luna");
    expect(OPENAI_PICKER_MODELS).toContain("gpt-5.4-mini");
    expect(OPENAI_PICKER_MODELS).toContain("o3");
    expect(OPENAI_PICKER_MODELS).toContain("o4-mini");
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
    expect(normalizeOpenAiModelId("gpt-5.5")).toBe("gpt-5.5");
  });

  it("maps legacy OpenRouter-style openai/slug ids", () => {
    expect(normalizeOpenAiModelId("openai/gpt-4o")).toBe("gpt-4o");
    expect(normalizeOpenAiModelId("openai/gpt-5.4-mini")).toBe("gpt-5.4-mini");
  });

  it("treats native and legacy openai ids as supported", () => {
    expect(openaiProvider.metadata.supportsModel("gpt-5.5")).toBe(true);
    expect(openaiProvider.metadata.supportsModel("openai/gpt-4o")).toBe(true);
    expect(openaiProvider.metadata.supportsModel("anthropic/claude-sonnet-4")).toBe(false);
  });

  it("returns a language model handle when configured", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { openai: { apiKey: "sk-openai" } } });
    vi.resetModules();
    const { openaiProvider: provider } = await import("./openai.js");
    const model = provider.languageModel("openai/gpt-5.5");
    expect(model).toBeDefined();
    expect(typeof model).toBe("object");
  });

  it("identifies -pro models, including dated variants", () => {
    expect(isOpenAiProModel("gpt-5.5-pro")).toBe(true);
    expect(isOpenAiProModel("openai:gpt-5.4-pro")).toBe(true);
    expect(isOpenAiProModel("openai/gpt-5.4-pro-2026-03-05")).toBe(true);
    expect(isOpenAiProModel("o3-pro")).toBe(true);
    expect(isOpenAiProModel("gpt-5.5")).toBe(false);
    expect(isOpenAiProModel("gpt-5.4-mini")).toBe(false);
  });

  it("identifies reasoning models, excluding gpt-5-chat variants", () => {
    expect(isOpenAiReasoningModel("gpt-5.6")).toBe(true);
    expect(isOpenAiReasoningModel("gpt-5.6-terra")).toBe(true);
    expect(isOpenAiReasoningModel("gpt-5.6-luna")).toBe(true);
    expect(isOpenAiReasoningModel("gpt-5.5")).toBe(true);
    expect(isOpenAiReasoningModel("o3")).toBe(true);
    expect(isOpenAiReasoningModel("o4-mini")).toBe(true);
    expect(isOpenAiReasoningModel("gpt-5-chat-latest")).toBe(false);
    expect(isOpenAiReasoningModel("gpt-4.1")).toBe(false);
    expect(isOpenAiReasoningModel("gpt-4o")).toBe(false);
  });

  it("routes reasoning and -pro models to the Responses API", () => {
    expect(shouldUseOpenAiResponsesApi("gpt-5.6-terra")).toBe(true);
    expect(shouldUseOpenAiResponsesApi("gpt-5.5-pro")).toBe(true);
    expect(shouldUseOpenAiResponsesApi("gpt-4.1")).toBe(false);
    expect(shouldUseOpenAiResponsesApi("gpt-4o")).toBe(false);
  });

  it("routes reasoning models to Responses API and non-reasoning to Chat Completions", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { openai: { apiKey: "sk-openai" } } });
    vi.resetModules();
    const { openaiProvider: provider } = await import("./openai.js");

    const pro = provider.languageModel("openai/gpt-5.5-pro") as { provider: string };
    const terra = provider.languageModel("openai/gpt-5.6-terra") as { provider: string };
    const chat = provider.languageModel("openai/gpt-4.1") as { provider: string };
    expect(pro.provider).toBe("openai.responses");
    expect(terra.provider).toBe("openai.responses");
    expect(chat.provider).toBe("openai.chat");
  });

  it("is registered in the provider registry", async () => {
    const { getProvider, providerSummaries } = await import("../registry.js");
    expect(getProvider("openai")?.id).toBe("openai");
    expect(providerSummaries().some((p) => p.id === "openai")).toBe(true);
  });

  it("resolves context windows from models.dev", async () => {
    globalThis.fetch = mockFetch({
      "/api.json": {
        body: {
          openai: {
            id: "openai",
            models: {
              "gpt-5.6": { id: "gpt-5.6", limit: { context: 1050000, output: 128000 } },
              "gpt-5.6-terra": { id: "gpt-5.6-terra", limit: { context: 1050000, output: 128000 } },
              "gpt-5.5": { id: "gpt-5.5", limit: { context: 1050000, output: 128000 } },
              "gpt-5.4-mini": { id: "gpt-5.4-mini", limit: { context: 400000, output: 128000 } },
            },
          },
        },
      },
    });

    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { openai: { apiKey: "sk-openai" } } });
    vi.resetModules();
    const { openaiProvider: provider } = await import("./openai.js");

    await expect(provider.metadata.getContextWindow("gpt-5.6")).resolves.toBe(1_050_000);
    await expect(provider.metadata.getContextWindow("gpt-5.6-terra")).resolves.toBe(1_050_000);
    await expect(provider.metadata.getContextWindow("gpt-5.5")).resolves.toBe(1_050_000);
    await expect(provider.metadata.getContextWindow("openai/gpt-5.5")).resolves.toBe(1_050_000);
    await expect(provider.metadata.getContextWindow("gpt-5.4-mini")).resolves.toBe(400_000);
  });

  it("falls back to offline picker defaults when models.dev is unreachable", async () => {
    globalThis.fetch = mockFetch({
      "/api.json": { ok: false, status: 503, body: {} },
    });

    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { openai: { apiKey: "sk-openai" } } });
    vi.resetModules();
    const { openaiProvider: provider } = await import("./openai.js");

    await expect(provider.metadata.getContextWindow("gpt-5.6")).resolves.toBe(1_050_000);
    await expect(provider.metadata.getContextWindow("gpt-5.5")).resolves.toBe(1_050_000);
    await expect(provider.metadata.getContextWindow("o4-mini")).resolves.toBe(200_000);
  });

  it("falls back to GET /v1/models when models.dev and offline table miss", async () => {
    globalThis.fetch = mockFetch({
      "/api.json": { ok: false, status: 503, body: {} },
      "/v1/models": {
        body: {
          data: [{ id: "custom-model", context_length: 64000 }],
        },
      },
    });

    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { openai: { apiKey: "sk-openai" } } });
    vi.resetModules();
    const { openaiProvider: provider } = await import("./openai.js");

    await expect(provider.metadata.getContextWindow("custom-model")).resolves.toBe(64000);
  });
});
