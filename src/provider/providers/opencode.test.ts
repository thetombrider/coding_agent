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

  describe("opencode-go", () => {
    it("reports unconfigured without credentials", () => {
      expect(opencodeGoProvider.isConfigured()).toBe(false);
    });

    it("reports configured when the env key is set", () => {
      process.env.OPENCODE_API_KEY = "sk-opencode";
      expect(opencodeGoProvider.isConfigured()).toBe(true);
    });

    it("exposes api-key config fields", () => {
      expect(opencodeGoProvider.configFields).toEqual([
        {
          key: "apiKey",
          label: "Opencode Go API key",
          secret: true,
          envVar: "OPENCODE_API_KEY",
        },
      ]);
    });

    it("returns a language model handle when configured", () => {
      process.env.OPENCODE_API_KEY = "sk-opencode";
      const model = opencodeGoProvider.languageModel("opencode-go");
      expect(model).toBeDefined();
      expect(typeof model).toBe("object");
    });

    it("is registered in the provider registry", async () => {
      const { getProvider, providerSummaries } = await import("../registry.js");
      expect(getProvider("opencode-go")?.id).toBe("opencode-go");
      expect(providerSummaries().some((p) => p.id === "opencode-go")).toBe(true);
    });
  });

  describe("opencode-zen", () => {
    it("reports unconfigured without credentials", () => {
      expect(opencodeZenProvider.isConfigured()).toBe(false);
    });

    it("reports configured when the env key is set", () => {
      process.env.OPENCODE_API_KEY = "sk-opencode";
      expect(opencodeZenProvider.isConfigured()).toBe(true);
    });

    it("exposes api-key config fields", () => {
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
      process.env.OPENCODE_API_KEY = "sk-opencode";
      const model = opencodeZenProvider.languageModel("opencode-zen");
      expect(model).toBeDefined();
      expect(typeof model).toBe("object");
    });

    it("is registered in the provider registry", async () => {
      const { getProvider, providerSummaries } = await import("../registry.js");
      expect(getProvider("opencode-zen")?.id).toBe("opencode-zen");
      expect(providerSummaries().some((p) => p.id === "opencode-zen")).toBe(true);
    });
  });

  it("both providers share OPENCODE_API_KEY", () => {
    process.env.OPENCODE_API_KEY = "sk-opencode";
    expect(opencodeGoProvider.isConfigured()).toBe(true);
    expect(opencodeZenProvider.isConfigured()).toBe(true);
  });
});
