import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cerebrasProvider } from "./cerebras.js";
import { resetModelsDevCache } from "../modelsdev.js";

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

describe("cerebras provider", () => {
  let home: string;
  let prevHome: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-cerebras-test-"));
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

  it("reports unconfigured without credentials", () => {
    expect(cerebrasProvider.isConfigured()).toBe(false);
  });

  it("reports configured when the config key is set", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { cerebras: { apiKey: "sk-cerebras" } } });
    vi.resetModules();
    const { cerebrasProvider: provider } = await import("./cerebras.js");
    expect(provider.isConfigured()).toBe(true);
  });

  it("exposes api-key config fields", () => {
    expect(cerebrasProvider.configFields).toEqual([
      {
        key: "apiKey",
        label: "Cerebras API key",
        secret: true,
      },
    ]);
  });

  it("returns a language model handle when configured", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { cerebras: { apiKey: "sk-cerebras" } } });
    vi.resetModules();
    const { cerebrasProvider: provider } = await import("./cerebras.js");
    const model = provider.languageModel("zai-glm-4.7");
    expect(model).toBeDefined();
    expect(typeof model).toBe("object");
  });

  it("is registered in the provider registry", async () => {
    const { getProvider, providerSummaries } = await import("../registry.js");
    expect(getProvider("cerebras")?.id).toBe("cerebras");
    expect(providerSummaries().some((p) => p.id === "cerebras")).toBe(true);
  });

  it("resolves context windows from the models.dev cerebras entry (case-insensitive)", async () => {
    const catalog = {
      cerebras: {
        id: "cerebras",
        models: {
          "zai-glm-4.7": { id: "zai-glm-4.7", limit: { context: 131072, output: 8192 } },
          "gpt-oss-120b": { id: "gpt-oss-120b", limit: { context: 131072, output: 8192 } },
          "gemma-4-31b": { id: "gemma-4-31b", limit: { context: 131072, output: 8192 } },
        },
      },
    };
    globalThis.fetch = mockModelsDevFetch(catalog);

    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { cerebras: { apiKey: "sk-cerebras" } } });
    vi.resetModules();
    const { cerebrasProvider: provider } = await import("./cerebras.js");
    await expect(provider.metadata.getContextWindow("zai-glm-4.7")).resolves.toBe(131072);
    await expect(provider.metadata.getContextWindow("gpt-oss-120b")).resolves.toBe(131072);
    await expect(provider.metadata.getContextWindow("gemma-4-31b")).resolves.toBe(131072);
    // Unknown model → undefined.
    await expect(provider.metadata.getContextWindow("does-not-exist")).resolves.toBeUndefined();
  });
});