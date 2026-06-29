import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { regoloProvider } from "./regolo.js";
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

describe("regolo provider", () => {
  let home: string;
  let prevHome: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-regolo-test-"));
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
    expect(regoloProvider.isConfigured()).toBe(false);
  });

  it("reports configured when the config key is set", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { regolo: { apiKey: "sk-regolo" } } });
    vi.resetModules();
    const { regoloProvider: provider } = await import("./regolo.js");
    expect(provider.isConfigured()).toBe(true);
  });

  it("exposes api-key config fields", () => {
    expect(regoloProvider.configFields).toEqual([
      {
        key: "apiKey",
        label: "Regolo AI API key",
        secret: true,
      },
    ]);
  });

  it("returns a language model handle when configured", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { regolo: { apiKey: "sk-regolo" } } });
    vi.resetModules();
    const { regoloProvider: provider } = await import("./regolo.js");
    const model = provider.languageModel("Llama-3.3-70B-Instruct");
    expect(model).toBeDefined();
    expect(typeof model).toBe("object");
  });

  it("is registered in the provider registry", async () => {
    const { getProvider, providerSummaries } = await import("../registry.js");
    expect(getProvider("regolo")?.id).toBe("regolo");
    expect(providerSummaries().some((p) => p.id === "regolo")).toBe(true);
  });

  it("resolves context windows from the models.dev regolo-ai entry (case-insensitive)", async () => {
    const catalog = {
      "regolo-ai": {
        id: "regolo-ai",
        models: {
          "llama-3.3-70b-instruct": { id: "llama-3.3-70b-instruct", limit: { context: 128000, output: 16384 } },
          "qwen3-coder-next": { id: "qwen3-coder-next", limit: { context: 262144, output: 16384 } },
        },
      },
    };
    globalThis.fetch = mockModelsDevFetch(catalog);

    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { regolo: { apiKey: "sk-regolo" } } });
    vi.resetModules();
    const { regoloProvider: provider } = await import("./regolo.js");
    // Our mixed-case id resolves to the lowercase models.dev entry.
    await expect(provider.metadata.getContextWindow("Llama-3.3-70B-Instruct")).resolves.toBe(128000);
    await expect(provider.metadata.getContextWindow("qwen3-coder-next")).resolves.toBe(262144);
    // Unknown model → undefined (falls through to 32K default in context-window.ts).
    await expect(provider.metadata.getContextWindow("does-not-exist")).resolves.toBeUndefined();
  });
});
