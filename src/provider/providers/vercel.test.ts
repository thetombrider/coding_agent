import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERCEL_PICKER_MODELS, vercelProvider } from "./vercel.js";
import { resetModelsDevCache } from "../modelsdev.js";

const TEST_API_KEY = "test-vercel-key";

function mockModelsDevFetch(body: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("models.dev/api.json")) {
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

describe("vercel provider", () => {
  let home: string;
  let prevHome: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-vercel-test-"));
    process.env.HOME = home;
    originalFetch = globalThis.fetch;
    resetModelsDevCache();
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    globalThis.fetch = originalFetch;
    resetModelsDevCache();
    rmSync(home, { recursive: true, force: true });
  });

  it("lists curated gateway models in the picker", () => {
    expect(VERCEL_PICKER_MODELS).toContain("anthropic/claude-sonnet-4.6");
    expect(VERCEL_PICKER_MODELS).toContain("openai/gpt-5.4-mini");
  });

  it("reports unconfigured without credentials", () => {
    expect(vercelProvider.isConfigured()).toBe(false);
  });

  it("reports configured when the config key is set", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { vercel: { apiKey: TEST_API_KEY } } });
    vi.resetModules();
    const { vercelProvider: provider } = await import("./vercel.js");
    expect(provider.isConfigured()).toBe(true);
  });

  it("normalizes vercel-prefixed model ids", () => {
    expect(vercelProvider.normalizeModelId("vercel:openai/gpt-5.4-mini")).toBe("openai/gpt-5.4-mini");
  });

  it("exposes api-key config fields", () => {
    expect(vercelProvider.configFields).toEqual([
      {
        key: "apiKey",
        label: "Vercel AI Gateway API key",
        secret: true,
      },
    ]);
  });

  it("returns a language model handle when configured", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { vercel: { apiKey: TEST_API_KEY } } });
    vi.resetModules();
    const { vercelProvider: provider } = await import("./vercel.js");
    const model = provider.languageModel("anthropic/claude-sonnet-4.6");
    expect(model).toBeDefined();
    expect(typeof model).toBe("object");
  });

  it("is registered in the provider registry", async () => {
    const { getProvider, providerSummaries } = await import("../registry.js");
    expect(getProvider("vercel")?.id).toBe("vercel");
    expect(providerSummaries().some((p) => p.id === "vercel")).toBe(true);
  });

  it("resolves context windows from the models.dev vercel entry", async () => {
    const catalog = {
      vercel: {
        id: "vercel",
        models: {
          "anthropic/claude-sonnet-4.6": {
            id: "anthropic/claude-sonnet-4.6",
            limit: { context: 1_000_000, output: 64_000 },
          },
          "openai/gpt-5.4-mini": {
            id: "openai/gpt-5.4-mini",
            limit: { context: 400_000, output: 128_000 },
          },
        },
      },
    };
    globalThis.fetch = mockModelsDevFetch(catalog);

    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { vercel: { apiKey: TEST_API_KEY } } });
    vi.resetModules();
    const { vercelProvider: provider } = await import("./vercel.js");
    await expect(provider.metadata.getContextWindow("anthropic/claude-sonnet-4.6")).resolves.toBe(1_000_000);
    await expect(provider.metadata.getContextWindow("openai/gpt-5.4-mini")).resolves.toBe(400_000);
    await expect(provider.metadata.getContextWindow("does-not-exist")).resolves.toBeUndefined();
  });
});
