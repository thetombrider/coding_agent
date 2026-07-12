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
    authStrategy: "api-key",
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
    defaultSlots: {
      main: "fake/model-a",
      explore: "fake/model-b",
      delegate_read: "fake/model-b",
      compaction: "fake/model-b",
    },
    ...overrides,
  };
}

describe("provider registry", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-registry-test-"));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("registers built-in providers", async () => {
    const { getProvider, listProviders, metadataProviders } = await import("./registry.js");
    const openrouter = getProvider("openrouter");
    expect(openrouter?.id).toBe("openrouter");
    expect(openrouter?.authStrategy).toBe("api-key");
    expect(listProviders().some((p) => p.id === "openrouter")).toBe(true);
    expect(listProviders().some((p) => p.id === "openai")).toBe(true);
    expect(listProviders().some((p) => p.id === "regolo")).toBe(true);
    expect(listProviders().some((p) => p.id === "cerebras")).toBe(true);
    expect(listProviders().some((p) => p.id === "vercel")).toBe(true);
    expect(metadataProviders().some((m) => m.id === "openrouter")).toBe(true);
    expect(metadataProviders().some((m) => m.id === "openai")).toBe(true);
    expect(metadataProviders().some((m) => m.id === "regolo")).toBe(true);
    expect(metadataProviders().some((m) => m.id === "cerebras")).toBe(true);
    expect(metadataProviders().some((m) => m.id === "vercel")).toBe(true);
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

  it("repairs an unconfigured active provider to the first configured backend", async () => {
    const { saveConfig, loadConfig } = await import("../config/config.js");
    saveConfig({ provider: { active: "anthropic", openrouter: { apiKey: "sk-or-test" } } });
    const { repairActiveProviderIfNeeded } = await import("./registry.js");
    expect(repairActiveProviderIfNeeded().id).toBe("openrouter");
    expect(loadConfig().provider.active).toBe("openrouter");
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
    expect(fake).toMatchObject({ active: true, configured: true, authStrategy: "api-key" });
    // No key in config → OpenRouter is registered but not configured.
    expect(openrouter).toMatchObject({ active: false, configured: false });
  });

  it("reports OpenRouter configured when the config key is set", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ provider: { openrouter: { apiKey: "sk-or-test" } } });
    vi.resetModules();
    const { getProvider } = await import("./registry.js");
    expect(getProvider("openrouter")?.isConfigured()).toBe(true);
  });

  it("reports Regolo configured when the config key is set", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ provider: { regolo: { apiKey: "sk-regolo-test" } } });
    vi.resetModules();
    const { getProvider } = await import("./registry.js");
    expect(getProvider("regolo")?.isConfigured()).toBe(true);
  });

  it("reports Cerebras configured when the config key is set", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ provider: { cerebras: { apiKey: "sk-cerebras-test" } } });
    vi.resetModules();
    const { getProvider } = await import("./registry.js");
    expect(getProvider("cerebras")?.isConfigured()).toBe(true);
  });

  it("reports OpenAI configured when the config key is set", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ provider: { openai: { apiKey: "sk-openai-test" } } });
    vi.resetModules();
    const { getProvider } = await import("./registry.js");
    expect(getProvider("openai")?.isConfigured()).toBe(true);
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

  it("returns cerebras picker models when cerebras is active", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ provider: { active: "cerebras" } });
    const { resolvePickerModels } = await import("./registry.js");
    const { CEREBRAS_PICKER_MODELS } = await import("./providers/cerebras.js");
    expect(resolvePickerModels()).toEqual(CEREBRAS_PICKER_MODELS);
  });

  it("returns openai picker models when openai is active", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ provider: { active: "openai" } });
    const { resolvePickerModels } = await import("./registry.js");
    const { OPENAI_PICKER_MODELS } = await import("./providers/openai.js");
    expect(resolvePickerModels()).toEqual(OPENAI_PICKER_MODELS);
  });

  it("appends config picker extras after bundled defaults", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({
      provider: { active: "openrouter" },
      models: { providers: { openrouter: { pickerExtras: ["custom/model-a", "custom/model-b"] } } },
    });
    const { resolvePickerModels } = await import("./registry.js");
    const { OPENROUTER_PICKER_MODELS } = await import("./providers/openrouter.js");
    expect(resolvePickerModels()).toEqual([...OPENROUTER_PICKER_MODELS, "custom/model-a", "custom/model-b"]);
  });

  it("keeps bundled picker models when config only has a legacy subset", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({
      provider: { active: "openrouter" },
      models: {
        picker: {
          openrouter: [
            "anthropic/claude-opus-4.8",
            "anthropic/claude-sonnet-4.6",
            "google/gemini-3.5-flash",
            "google/gemini-3.1-flash-lite",
            "deepseek/deepseek-v4-pro",
            "minimax/minimax-m3",
            "z-ai/glm-5.1",
            "inception/mercury-2",
            "arcee-ai/trinity-large-thinking",
            "mistralai/mistral-large-2512",
          ],
        },
      },
    } as Parameters<typeof saveConfig>[0]);
    const { resolvePickerModels } = await import("./registry.js");
    const { OPENROUTER_PICKER_MODELS } = await import("./providers/openrouter.js");
    expect(resolvePickerModels()).toEqual(OPENROUTER_PICKER_MODELS);
  });
});
