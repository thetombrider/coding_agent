import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeGoProvider, opencodeZenProvider } from "./opencode.js";

describe("opencode providers", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-opencode-test-"));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
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

  describe("opencode-go", () => {
    it("has correct provider id and display name", () => {
      expect(opencodeGoProvider.id).toBe("opencode-go");
      expect(opencodeGoProvider.displayName).toBe("Opencode Go");
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
      for (const modelId of ["kimi-k2.7", "glm-5.2", "deepseek-v4-flash", "mimo-v2.5-pro"]) {
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
      expect(opencodeGoProvider.defaultModels.main).toBe("kimi-k2.7");
      expect(opencodeGoProvider.defaultModels.cheap).toBe("deepseek-v4-flash");
    });

    it("is registered in the provider registry", async () => {
      const { getProvider, providerSummaries } = await import("../registry.js");
      expect(getProvider("opencode-go")?.id).toBe("opencode-go");
      expect(providerSummaries().some((p) => p.id === "opencode-go")).toBe(true);
    });
  });

  describe("opencode-zen", () => {
    it("has correct provider id and display name", () => {
      expect(opencodeZenProvider.id).toBe("opencode-zen");
      expect(opencodeZenProvider.displayName).toBe("Opencode Zen");
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
      const model = provider.languageModel("kimi-k2");
      expect(model).toBeDefined();
      expect(typeof model).toBe("object");
    });

    it("has sensible defaults", () => {
      expect(opencodeZenProvider.defaultModels.main).toBe("kimi-k2");
      expect(opencodeZenProvider.defaultModels.cheap).toBe("glm-4.7-free");
    });

    it("is registered in the provider registry", async () => {
      const { getProvider, providerSummaries } = await import("../registry.js");
      expect(getProvider("opencode-zen")?.id).toBe("opencode-zen");
      expect(providerSummaries().some((p) => p.id === "opencode-zen")).toBe(true);
    });
  });
});
