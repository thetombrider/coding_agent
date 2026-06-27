import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const osState = vi.hoisted(() => ({ home: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => osState.home || actual.homedir(),
  };
});

describe("resolveProviderSlot", () => {
  let env: NodeJS.ProcessEnv;
  let home: string;

  beforeEach(() => {
    env = { ...process.env };
    home = mkdtempSync(join(tmpdir(), "orin-models-test-"));
    osState.home = home;
    process.env = { ...env, HOME: home };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...env };
    osState.home = "";
    rmSync(home, { recursive: true, force: true });
  });

  it("uses bundled defaults when config is unset", async () => {
    const { resolveProviderSlot } = await import("./models.js");
    expect(resolveProviderSlot("openrouter", "main")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveProviderSlot("openrouter", "explore")).toBe("deepseek/deepseek-v4-flash");
    expect(resolveProviderSlot("openrouter", "delegate_read")).toBe("deepseek/deepseek-v4-flash");
    expect(resolveProviderSlot("openrouter", "compaction")).toBe("deepseek/deepseek-v4-flash");
  });

  it("reads slot pins from config", async () => {
    const { saveConfig } = await import("./config.js");
    saveConfig({
      models: {
        providers: {
          openrouter: {
            main: "openai/gpt-4o",
            delegate_read: "meta-llama/llama-3.1-8b-instruct",
          },
        },
      },
    });
    const { resolveProviderSlot } = await import("./models.js");
    expect(resolveProviderSlot("openrouter", "main")).toBe("openai/gpt-4o");
    expect(resolveProviderSlot("openrouter", "delegate_read")).toBe("meta-llama/llama-3.1-8b-instruct");
  });

  it("scopes picker models to the active provider", async () => {
    const { saveConfig } = await import("./config.js");
    saveConfig({ provider: { active: "regolo" } });
    const { pickerModelsForProvider } = await import("./models.js");
    const { REGOLO_PICKER_MODELS } = await import("../provider/providers/regolo.js");
    expect(pickerModelsForProvider()).toEqual(REGOLO_PICKER_MODELS);
  });

  it("uses provider defaults when a pin is incompatible", async () => {
    const { saveConfig } = await import("./config.js");
    saveConfig({
      provider: { active: "regolo" },
      models: { providers: { regolo: { main: "anthropic/claude-sonnet-4" } } },
    });
    const { resolveProviderSlot } = await import("./models.js");
    expect(resolveProviderSlot("regolo", "main")).toBe("Llama-3.3-70B-Instruct");
  });

  it("migrates legacy main into providers on load", async () => {
    const { saveConfig, loadConfig } = await import("./config.js");
    saveConfig({ models: { main: "custom/model" } } as Parameters<typeof saveConfig>[0]);
    expect(loadConfig().models.providers.openrouter?.main).toBe("custom/model");
  });

  it("keeps delegate_read and compaction independent", async () => {
    const { saveProviderModelSlot } = await import("./config.js");
    saveProviderModelSlot("openrouter", "delegate_read", "model/a");
    saveProviderModelSlot("openrouter", "compaction", "model/b");
    const { resolveProviderSlot } = await import("./models.js");
    expect(resolveProviderSlot("openrouter", "delegate_read")).toBe("model/a");
    expect(resolveProviderSlot("openrouter", "compaction")).toBe("model/b");
  });
});

describe("resolvePresetModel", () => {
  let env: NodeJS.ProcessEnv;
  let home: string;

  beforeEach(() => {
    env = { ...process.env };
    home = mkdtempSync(join(tmpdir(), "orin-roles-test-"));
    osState.home = home;
    process.env = { ...env, HOME: home };
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...env };
    osState.home = "";
    rmSync(home, { recursive: true, force: true });
  });

  it("routes explore to the explore slot default", async () => {
    const { resolvePresetModel } = await import("./models.js");
    expect(resolvePresetModel("explore")).toBe("deepseek/deepseek-v4-flash");
  });

  it("routes review to the main slot", async () => {
    const { saveProviderModelSlot } = await import("./config.js");
    saveProviderModelSlot("openrouter", "main", "z-ai/glm-5.1");
    const { resolvePresetModel } = await import("./models.js");
    expect(resolvePresetModel("review")).toBe("z-ai/glm-5.1");
  });

  it("routes implement to the code-tuned model when the provider supports it", async () => {
    const { resolvePresetModel } = await import("./models.js");
    expect(resolvePresetModel("implement")).toBe("moonshotai/kimi-k2.7-code");
  });

  it("falls implement back to main when the code model is unsupported", async () => {
    const { saveConfig } = await import("./config.js");
    saveConfig({ provider: { active: "regolo" } });
    const { resolvePresetModel } = await import("./models.js");
    expect(resolvePresetModel("implement")).toBe("Llama-3.3-70B-Instruct");
  });

  it("lets a provider-supported config override win over the role default", async () => {
    const { saveConfig } = await import("./config.js");
    saveConfig({
      models: {
        providers: {
          openrouter: { explore: "z-ai/glm-5.1", implement: "qwen/qwen3.7-plus" },
        },
      },
    });
    const { resolvePresetModel } = await import("./models.js");
    expect(resolvePresetModel("explore")).toBe("z-ai/glm-5.1");
    expect(resolvePresetModel("implement")).toBe("qwen/qwen3.7-plus");
  });

  it("falls back to slot defaults when the override is unsupported by the provider", async () => {
    const { saveConfig } = await import("./config.js");
    saveConfig({
      provider: { active: "regolo" },
      models: { providers: { regolo: { explore: "anthropic/claude-sonnet-4" } } },
    });
    const { resolvePresetModel } = await import("./models.js");
    expect(resolvePresetModel("explore")).toBe("qwen3.5-9b");
  });

  it("applies a provider-scoped override only on its own provider", async () => {
    const { saveConfig } = await import("./config.js");
    saveConfig({ models: { providers: { openrouter: { explore: "z-ai/glm-5.1" } } } });
    const { resolvePresetModel } = await import("./models.js");
    expect(resolvePresetModel("explore", "openrouter")).toBe("z-ai/glm-5.1");
    expect(resolvePresetModel("explore", "regolo")).toBe("qwen3.5-9b");
  });

  it("keeps independent overrides per provider", async () => {
    const { saveProviderModelSlot } = await import("./config.js");
    saveProviderModelSlot("openrouter", "explore", "z-ai/glm-5.1");
    saveProviderModelSlot("regolo", "explore", "Llama-3.3-70B-Instruct");
    const { resolvePresetModel } = await import("./models.js");
    expect(resolvePresetModel("explore", "openrouter")).toBe("z-ai/glm-5.1");
    expect(resolvePresetModel("explore", "regolo")).toBe("Llama-3.3-70B-Instruct");
  });

  it("migrates a legacy flat roles override onto the active provider", async () => {
    const { saveConfig, loadConfig } = await import("./config.js");
    saveConfig({
      provider: { active: "regolo" },
      models: { roles: { explore: "Llama-3.3-70B-Instruct" } },
    } as Parameters<typeof saveConfig>[0]);
    expect(loadConfig().models.providers.regolo?.explore).toBe("Llama-3.3-70B-Instruct");
    const { resolvePresetModel } = await import("./models.js");
    expect(resolvePresetModel("explore", "regolo")).toBe("Llama-3.3-70B-Instruct");
  });

  it("clears a provider's override without touching another provider's", async () => {
    const { saveProviderModelSlot, loadConfig } = await import("./config.js");
    saveProviderModelSlot("openrouter", "explore", "z-ai/glm-5.1");
    saveProviderModelSlot("regolo", "explore", "Llama-3.3-70B-Instruct");
    saveProviderModelSlot("openrouter", "explore", "default");
    expect(loadConfig().models.providers).toEqual({
      regolo: { explore: "Llama-3.3-70B-Instruct" },
    });
  });
});
