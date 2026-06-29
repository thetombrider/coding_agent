import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeGoProvider, opencodeZenProvider } from "./opencode.js";
import { resetModelsDevCache } from "../modelsdev.js";

/** Build a models.dev catalog body from a map of (provider → model → context). */
function modelsDevCatalogFixture(
  windows: Record<string, Record<string, number>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(windows).map(([providerId, models]) => [
      providerId,
      {
        id: providerId,
        models: Object.fromEntries(
          Object.entries(models).map(([modelId, context]) => [
            modelId,
            { id: modelId, limit: { context, output: 16384 } },
          ]),
        ),
      },
    ]),
  );
}

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

describe("opencode providers", () => {
  let home: string;
  let prevHome: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-opencode-test-"));
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

  it("both providers report unconfigured without credentials", () => {
    expect(opencodeGoProvider.isConfigured()).toBe(false);
    expect(opencodeZenProvider.isConfigured()).toBe(false);
  });

  it("both providers report configured when the config key is set", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { opencode: { apiKey: "sk-opencode-test" } } });
    vi.resetModules();
    const { opencodeGoProvider: go, opencodeZenProvider: zen } = await import("./opencode.js");
    expect(go.isConfigured()).toBe(true);
    expect(zen.isConfigured()).toBe(true);
  });

  it("saveProviderConfig for opencode-go writes to the shared opencode section", async () => {
    const { saveProviderConfig } = await import("../../config/config.js");
    saveProviderConfig("opencode-go", { apiKey: "sk-opencode-shared" }, "opencode");
    vi.resetModules();
    const { opencodeGoProvider: go, opencodeZenProvider: zen } = await import("./opencode.js");
    expect(go.isConfigured()).toBe(true);
    expect(zen.isConfigured()).toBe(true);
  });

  describe("opencode-go", () => {
    it("has correct provider id and display name", () => {
      expect(opencodeGoProvider.id).toBe("opencode-go");
      expect(opencodeGoProvider.displayName).toBe("Opencode Go");
    });

    it("shares the opencode config section", () => {
      expect(opencodeGoProvider.configSection).toBe("opencode");
    });

    it("exposes api key config field", () => {
      expect(opencodeGoProvider.configFields).toEqual([
        {
          key: "apiKey",
          label: "Opencode API key",
          secret: true,
        },
      ]);
    });

    it("returns a language model handle for OpenAI-compat models", async () => {
      const { saveConfig } = await import("../../config/config.js");
      saveConfig({ provider: { opencode: { apiKey: "sk-opencode-test" } } });
      vi.resetModules();
      const { opencodeGoProvider: provider } = await import("./opencode.js");
      for (const modelId of ["kimi-k2.7-code", "glm-5.2", "deepseek-v4-flash", "mimo-v2.5-pro"]) {
        const model = provider.languageModel(modelId);
        expect(model, `${modelId} should be defined`).toBeDefined();
        expect(typeof model).toBe("object");
      }
    });

    it("returns a language model handle for Anthropic-compat models", async () => {
      const { saveConfig } = await import("../../config/config.js");
      saveConfig({ provider: { opencode: { apiKey: "sk-opencode-test" } } });
      vi.resetModules();
      const { opencodeGoProvider: provider } = await import("./opencode.js");
      for (const modelId of ["minimax-m3", "qwen3.7-max", "minimax-m2.5", "qwen3.6-plus"]) {
        const model = provider.languageModel(modelId);
        expect(model, `${modelId} should be defined`).toBeDefined();
        expect(typeof model).toBe("object");
      }
    });

    it("has all 14 models in pickerModels", () => {
      expect(opencodeGoProvider.pickerModels).toHaveLength(14);
    });

    it("has sensible defaults", () => {
      expect(opencodeGoProvider.defaultSlots.main).toBe("kimi-k2.7-code");
      expect(opencodeGoProvider.defaultSlots.explore).toBe("deepseek-v4-flash");
    });

    it("is registered in the provider registry", async () => {
      const { getProvider, providerSummaries } = await import("../registry.js");
      expect(getProvider("opencode-go")?.id).toBe("opencode-go");
      expect(providerSummaries().some((p) => p.id === "opencode-go")).toBe(true);
    });

    it("resolves context windows from the models.dev catalog (provider id: opencode-go)", async () => {
      const cases: Array<[string, number]> = [
        ["kimi-k2.7-code", 262_144],
        ["kimi-k2.6", 262_144],
        ["glm-5.2", 1_000_000],
        ["glm-5.1", 202_752],
        ["deepseek-v4-pro", 1_000_000],
        ["deepseek-v4-flash", 1_000_000],
        ["mimo-v2.5-pro", 1_048_576],
        ["mimo-v2.5", 1_000_000],
        ["minimax-m3", 1_000_000],
        ["minimax-m2.7", 204_800],
        ["qwen3.7-max", 1_000_000],
        ["qwen3.6-plus", 1_000_000],
      ];
      const catalog = modelsDevCatalogFixture({
        "opencode-go": Object.fromEntries(cases),
      });
      globalThis.fetch = mockModelsDevFetch(catalog);

      const { saveConfig } = await import("../../config/config.js");
      saveConfig({ provider: { opencode: { apiKey: "sk-opencode-test" } } });
      vi.resetModules();
      const { opencodeGoProvider: provider } = await import("./opencode.js");
      for (const [modelId, expected] of cases) {
        await expect(provider.metadata.getContextWindow(modelId)).resolves.toBe(expected);
      }
    });

    it("falls back to the curated offline table when models.dev is unreachable", async () => {
      globalThis.fetch = mockModelsDevFetch({ "opencode-go": { id: "opencode-go", models: {} } });

      const { saveConfig } = await import("../../config/config.js");
      saveConfig({ provider: { opencode: { apiKey: "sk-opencode-test" } } });
      vi.resetModules();
      const { opencodeGoProvider: provider } = await import("./opencode.js");
      // Catalog empty → offline table still serves the curated picker model.
      await expect(provider.metadata.getContextWindow("kimi-k2.7-code")).resolves.toBe(262_144);
      // Unknown id → undefined.
      await expect(provider.metadata.getContextWindow("not-a-real-model")).resolves.toBeUndefined();
    });
  });

  describe("opencode-zen", () => {
    it("has correct provider id and display name", () => {
      expect(opencodeZenProvider.id).toBe("opencode-zen");
      expect(opencodeZenProvider.displayName).toBe("Opencode Zen");
    });

    it("shares the opencode config section", () => {
      expect(opencodeZenProvider.configSection).toBe("opencode");
    });

    it("exposes api key config field", () => {
      expect(opencodeZenProvider.configFields).toEqual([
        {
          key: "apiKey",
          label: "Opencode Zen API key",
          secret: true,
        },
      ]);
    });

    it("returns a language model handle when configured", async () => {
      const { saveConfig } = await import("../../config/config.js");
      saveConfig({ provider: { opencode: { apiKey: "sk-opencode-test" } } });
      vi.resetModules();
      const { opencodeZenProvider: provider } = await import("./opencode.js");
      const model = provider.languageModel("kimi-k2.6");
      expect(model).toBeDefined();
      expect(typeof model).toBe("object");
    });

    it("has sensible defaults", () => {
      expect(opencodeZenProvider.defaultSlots.main).toBe("kimi-k2.6");
      expect(opencodeZenProvider.defaultSlots.explore).toBe("deepseek-v4-flash-free");
    });

    it("is registered in the provider registry", async () => {
      const { getProvider, providerSummaries } = await import("../registry.js");
      expect(getProvider("opencode-zen")?.id).toBe("opencode-zen");
      expect(providerSummaries().some((p) => p.id === "opencode-zen")).toBe(true);
    });

    it("resolves context windows from the models.dev catalog (provider id: opencode)", async () => {
      const cases: Array<[string, number]> = [
        ["claude-sonnet-4-5", 1_000_000],
        ["claude-sonnet-4-6", 1_000_000],
        ["claude-opus-4-5", 200_000],
        ["gpt-5.4", 1_050_000],
        ["gpt-5.4-mini", 400_000],
        ["kimi-k2.6", 262_144],
        ["grok-build-0.1", 256_000],
        ["gemini-3-flash", 1_048_576],
        ["deepseek-v4-flash", 1_000_000],
        ["deepseek-v4-flash-free", 200_000],
      ];
      const catalog = modelsDevCatalogFixture({ opencode: Object.fromEntries(cases) });
      globalThis.fetch = mockModelsDevFetch(catalog);

      const { saveConfig } = await import("../../config/config.js");
      saveConfig({ provider: { opencode: { apiKey: "sk-opencode-test" } } });
      vi.resetModules();
      const { opencodeZenProvider: provider } = await import("./opencode.js");
      for (const [modelId, expected] of cases) {
        await expect(provider.metadata.getContextWindow(modelId)).resolves.toBe(expected);
      }
    });

    it("falls back to the curated offline table when models.dev is unreachable", async () => {
      globalThis.fetch = mockModelsDevFetch({ opencode: { id: "opencode", models: {} } });

      const { saveConfig } = await import("../../config/config.js");
      saveConfig({ provider: { opencode: { apiKey: "sk-opencode-test" } } });
      vi.resetModules();
      const { opencodeZenProvider: provider } = await import("./opencode.js");
      // Catalog empty → offline table still serves the curated picker model.
      await expect(provider.metadata.getContextWindow("claude-sonnet-4-5")).resolves.toBe(1_000_000);
      // Unknown id → undefined.
      await expect(provider.metadata.getContextWindow("not-a-real-model")).resolves.toBeUndefined();
    });
  });
});
