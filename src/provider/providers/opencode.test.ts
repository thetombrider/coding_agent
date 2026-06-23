import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeGoProvider, opencodeZenProvider } from "./opencode.js";

describe("opencode providers", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevKey: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevKey = process.env.OPENCODE_API_KEY;
    home = mkdtempSync(join(tmpdir(), "orin-opencode-test-"));
    process.env.HOME = home;
    delete process.env.OPENCODE_API_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = prevKey;
    rmSync(home, { recursive: true, force: true });
  });

  it("both providers report unconfigured without credentials", () => {
    expect(opencodeGoProvider.isConfigured()).toBe(false);
    expect(opencodeZenProvider.isConfigured()).toBe(false);
  });

  it("both providers report configured when OPENCODE_API_KEY is set", () => {
    process.env.OPENCODE_API_KEY = "sk-opencode-test";
    expect(opencodeGoProvider.isConfigured()).toBe(true);
    expect(opencodeZenProvider.isConfigured()).toBe(true);
  });

  describe("opencode-go", () => {
    it("has correct provider id and display name", () => {
      expect(opencodeGoProvider.id).toBe("opencode-go");
      expect(opencodeGoProvider.displayName).toBe("Opencode Go");
    });

    it("exposes OPENCODE_API_KEY config field", () => {
      expect(opencodeGoProvider.configFields).toEqual([
        {
          key: "apiKey",
          label: "Opencode API key",
          secret: true,
          envVar: "OPENCODE_API_KEY",
        },
      ]);
    });

    it("returns a language model handle for OpenAI-compat models", () => {
      process.env.OPENCODE_API_KEY = "sk-opencode-test";
      for (const modelId of ["kimi-k2.7", "glm-5.2", "deepseek-v4-flash", "mimo-v2.5-pro"]) {
        const model = opencodeGoProvider.languageModel(modelId);
        expect(model, `${modelId} should be defined`).toBeDefined();
        expect(typeof model).toBe("object");
      }
    });

    it("returns a language model handle for Anthropic-compat models", () => {
      process.env.OPENCODE_API_KEY = "sk-opencode-test";
      for (const modelId of ["minimax-m3", "qwen3.7-max", "minimax-m2.5", "qwen3.6-plus"]) {
        const model = opencodeGoProvider.languageModel(modelId);
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

    it("exposes OPENCODE_API_KEY config field", () => {
      expect(opencodeZenProvider.configFields).toEqual([
        {
          key: "apiKey",
          label: "Opencode Zen API key",
          secret: true,
          envVar: "OPENCODE_API_KEY",
        },
      ]);
    });

    it("returns a language model handle when configured", () => {
      process.env.OPENCODE_API_KEY = "sk-opencode-test";
      const model = opencodeZenProvider.languageModel("kimi-k2");
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
