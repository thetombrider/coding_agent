import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import type { Provider } from "./types.js";

const sentinelModel = { id: "sentinel" } as unknown as LanguageModel;

function makeFakeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "fake",
    displayName: "Fake",
    authStrategy: "oauth",
    isConfigured: () => true,
    normalizeModelId: (modelId) => modelId,
    languageModel: () => sentinelModel,
    metadata: {
      id: "fake",
      supportsModel: () => true,
      getContextWindow: async () => 4242,
      listModelIds: async () => ["fake/model-a", "fake/model-b"],
    },
    pickerModels: ["fake/model-a", "fake/model-b"],
    defaultModels: { main: "fake/model-a", cheap: "fake/model-b" },
    ...overrides,
  };
}

describe("provider registry", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevKey: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevKey = process.env.OPENROUTER_API_KEY;
    home = mkdtempSync(join(tmpdir(), "orin-registry-test-"));
    process.env.HOME = home;
    delete process.env.OPENROUTER_API_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
    rmSync(home, { recursive: true, force: true });
  });

  it("registers OpenRouter and Regolo providers", async () => {
    const { getProvider, listProviders, metadataProviders } = await import("./registry.js");
    const openrouter = getProvider("openrouter");
    expect(openrouter?.id).toBe("openrouter");
    expect(openrouter?.authStrategy).toBe("api-key");
    expect(listProviders().some((p) => p.id === "openrouter")).toBe(true);
    expect(listProviders().some((p) => p.id === "regolo")).toBe(true);
    expect(metadataProviders().some((m) => m.id === "openrouter")).toBe(true);
    expect(metadataProviders().some((m) => m.id === "regolo")).toBe(true);
  });

  it("resolves the active provider from config", async () => {
    const { resolveActiveProvider } = await import("./registry.js");
    expect(resolveActiveProvider().id).toBe("openrouter");
  });

  it("falls back to the default when the active provider is unknown", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ provider: { active: "ghost" } });
    const { resolveActiveProvider, DEFAULT_PROVIDER_ID } = await import("./registry.js");
    expect(resolveActiveProvider().id).toBe(DEFAULT_PROVIDER_ID);
  });

  it("resolves the language model handle from the active provider", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ provider: { active: "fake" } });
    const { registerProvider, resolveLanguageModel } = await import("./registry.js");
    registerProvider(makeFakeProvider());
    expect(resolveLanguageModel("any/model")).toBe(sentinelModel);
  });

  it("summarises providers with active and configured flags", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ provider: { active: "fake" } });
    const { registerProvider, providerSummaries } = await import("./registry.js");
    registerProvider(makeFakeProvider());

    const summaries = providerSummaries();
    const fake = summaries.find((p) => p.id === "fake");
    const openrouter = summaries.find((p) => p.id === "openrouter");
    expect(fake).toMatchObject({ active: true, configured: true, authStrategy: "oauth" });
    // No OPENROUTER_API_KEY in env/config → OpenRouter is registered but not configured.
    expect(openrouter).toMatchObject({ active: false, configured: false });
  });

  it("reports OpenRouter configured when the env key is set", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const { getProvider } = await import("./registry.js");
    expect(getProvider("openrouter")?.isConfigured()).toBe(true);
  });

  it("reports Regolo configured when the env key is set", async () => {
    process.env.REGOLO_API_KEY = "sk-regolo-test";
    const { getProvider } = await import("./registry.js");
    expect(getProvider("regolo")?.isConfigured()).toBe(true);
  });

  it("exposes config fields for api-key providers", async () => {
    const { providerConfigFields } = await import("./registry.js");
    const fields = providerConfigFields("openrouter");
    expect(fields.some((f) => f.key === "apiKey")).toBe(true);
    expect(providerConfigFields("missing")).toEqual([]);
  });

  it("returns bundled picker models for the active provider", async () => {
    const { resolvePickerModels } = await import("./registry.js");
    const { OPENROUTER_PICKER_MODELS } = await import("./providers/openrouter.js");
    expect(resolvePickerModels("openrouter")).toEqual(OPENROUTER_PICKER_MODELS);
  });

  it("returns regolo picker models when regolo is active", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ provider: { active: "regolo" } });
    const { resolvePickerModels } = await import("./registry.js");
    const { REGOLO_PICKER_MODELS } = await import("./providers/regolo.js");
    expect(resolvePickerModels()).toEqual(REGOLO_PICKER_MODELS);
  });

  it("prefers config picker overrides over bundled defaults", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({
      provider: { active: "openrouter" },
      models: { picker: { openrouter: ["custom/model-a", "custom/model-b"] } },
    });
    const { resolvePickerModels } = await import("./registry.js");
    expect(resolvePickerModels()).toEqual(["custom/model-a", "custom/model-b"]);
  });
});
