import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "./types.js";
import {
  lastUsedPatchForProviderSwitch,
  modelLikelySupported,
  resolveModelOnProviderSwitch,
} from "./picker-models.js";

describe("picker-models", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-picker-models-test-"));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("rejects OpenRouter-style ids for regolo", async () => {
    const { regoloProvider } = await import("./providers/regolo.js");
    expect(modelLikelySupported(regoloProvider, "anthropic/claude-sonnet-4")).toBe(false);
    expect(modelLikelySupported(regoloProvider, "Llama-3.3-70B-Instruct")).toBe(true);
  });

  it("rejects native ids for openrouter", async () => {
    const { openRouterProvider } = await import("./providers/openrouter.js");
    expect(modelLikelySupported(openRouterProvider, "Llama-3.3-70B-Instruct")).toBe(false);
    expect(modelLikelySupported(openRouterProvider, "anthropic/claude-sonnet-4")).toBe(true);
  });

  it("auto-swaps to regolo default when switching from openrouter", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ provider: { active: "openrouter" } });
    const result = resolveModelOnProviderSwitch(
      "openrouter",
      "regolo",
      "anthropic/claude-sonnet-4",
    );
    expect(result.model).toBe("Llama-3.3-70B-Instruct");
    expect(result.note).toContain("Llama-3.3-70B-Instruct");
  });

  it("restores last-used model for the target provider", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({
      models: {
        lastUsed: { regolo: { main: "qwen3-coder-next" } },
      },
    });
    const result = resolveModelOnProviderSwitch(
      "openrouter",
      "regolo",
      "anthropic/claude-sonnet-4",
    );
    expect(result.model).toBe("qwen3-coder-next");
  });

  it("keeps the model when it is already compatible", async () => {
    const result = resolveModelOnProviderSwitch(
      "openrouter",
      "openrouter",
      "anthropic/claude-sonnet-4",
    );
    expect(result.model).toBeUndefined();
    expect(result.note).toBe("");
  });

  it("includes bundled models even when config has a legacy picker override", async () => {
    const { saveConfig } = await import("../config/config.js");
    const { OPENROUTER_PICKER_MODELS } = await import("./providers/openrouter.js");
    saveConfig({
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
    });
    const { loadPickerModels } = await import("./picker-models.js");
    await expect(loadPickerModels("openrouter")).resolves.toEqual([...OPENROUTER_PICKER_MODELS]);
  });

  it("filters curated picker models against the live catalog", async () => {
    const { registerProvider, getProvider } = await import("./registry.js");
    const { loadPickerModels: loadPicker } = await import("./picker-models.js");
    const fake: Provider = {
      id: "fake-catalog",
      displayName: "Fake",
      authStrategy: "api-key",
      isConfigured: () => true,
      normalizeModelId: (id) => id,
      languageModel: () => ({}) as never,
      metadata: {
        id: "fake-catalog",
        supportsModel: () => true,
        getContextWindow: async () => 1000,
        listModelIds: async () => ["good/model", "other/model"],
      },
      pickerModels: ["good/model", "stale/model"],
      defaultModels: { main: "good/model", cheap: "other/model" },
    };
    registerProvider(fake);
    expect(getProvider("fake-catalog")?.id).toBe("fake-catalog");
    await expect(loadPicker("fake-catalog")).resolves.toEqual(["good/model"]);
  });

  it("builds last-used patches for provider switches", () => {
    expect(lastUsedPatchForProviderSwitch("openrouter", "anthropic/claude-sonnet-4", "cheap/model")).toEqual({
      openrouter: { main: "anthropic/claude-sonnet-4", cheap: "cheap/model" },
    });
  });
});
