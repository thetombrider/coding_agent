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

describe("loadModelConfig", () => {
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

  it("uses fallbacks when config is unset", async () => {
    const { loadModelConfig } = await import("./models.js");
    expect(loadModelConfig()).toEqual({
      main: "anthropic/claude-sonnet-4.6",
      cheap: "deepseek/deepseek-v4-flash",
    });
  });

  it("reads main and cheap models from config", async () => {
    const { saveConfig } = await import("./config.js");
    saveConfig({
      models: {
        main: "openai/gpt-4o",
        cheap: "meta-llama/llama-3.1-8b-instruct",
      },
    });
    const { loadModelConfig } = await import("./models.js");
    expect(loadModelConfig()).toEqual({
      main: "openai/gpt-4o",
      cheap: "meta-llama/llama-3.1-8b-instruct",
    });
  });

  it("scopes picker models to the active provider", async () => {
    const { saveConfig } = await import("./config.js");
    saveConfig({ provider: { active: "regolo" } });
    const { pickerModelsForProvider } = await import("./models.js");
    const { REGOLO_PICKER_MODELS } = await import("../provider/providers/regolo.js");
    expect(pickerModelsForProvider()).toEqual(REGOLO_PICKER_MODELS);
  });

  it("uses provider defaults when the global main model is incompatible", async () => {
    const { saveConfig } = await import("./config.js");
    saveConfig({
      provider: { active: "regolo" },
      models: { main: "anthropic/claude-sonnet-4" },
    });
    const { defaultMainModel } = await import("./models.js");
    expect(defaultMainModel()).toBe("Llama-3.3-70B-Instruct");
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

  it("routes explore to the host cheap model by default", async () => {
    const { resolvePresetModel } = await import("./models.js");
    expect(resolvePresetModel("explore", "main:test", "cheap:test")).toBe("cheap:test");
  });

  it("routes review to the host main model by default", async () => {
    const { resolvePresetModel } = await import("./models.js");
    expect(resolvePresetModel("review", "main:test", "cheap:test")).toBe("main:test");
  });

  it("routes implement to the code-tuned model by default when the provider supports it", async () => {
    const { resolvePresetModel } = await import("./models.js");
    expect(resolvePresetModel("implement", "main:test", "cheap:test")).toBe("moonshotai/kimi-k2.7-code");
  });

  it("falls implement back to the main tier when the code model is unsupported", async () => {
    const { saveConfig } = await import("./config.js");
    saveConfig({ provider: { active: "regolo" } });
    const { resolvePresetModel } = await import("./models.js");
    expect(resolvePresetModel("implement", "main:test", "cheap:test")).toBe("main:test");
  });

  it("lets a provider-supported config override win over the role default", async () => {
    const { saveConfig } = await import("./config.js");
    saveConfig({ models: { roles: { openrouter: { explore: "z-ai/glm-5.1", implement: "qwen/qwen3.7-plus" } } } });
    const { resolvePresetModel } = await import("./models.js");
    expect(resolvePresetModel("explore", "main:test", "cheap:test")).toBe("z-ai/glm-5.1");
    expect(resolvePresetModel("implement", "main:test", "cheap:test")).toBe("qwen/qwen3.7-plus");
  });

  it("falls back to the tier default when the override is unsupported by the provider", async () => {
    const { saveConfig } = await import("./config.js");
    saveConfig({
      provider: { active: "regolo" },
      models: { roles: { regolo: { explore: "anthropic/claude-sonnet-4" } } },
    });
    const { resolvePresetModel } = await import("./models.js");
    expect(resolvePresetModel("explore", "main:test", "cheap:test")).toBe("cheap:test");
  });

  it("applies a provider-scoped override only on its own provider", async () => {
    const { saveConfig } = await import("./config.js");
    saveConfig({ models: { roles: { openrouter: { explore: "z-ai/glm-5.1" } } } });
    const { resolvePresetModel } = await import("./models.js");
    // The override is scoped to openrouter, so it applies there.
    expect(resolvePresetModel("explore", "main:test", "cheap:test", "openrouter")).toBe("z-ai/glm-5.1");
    // Regolo has no override of its own, so it stays on the tier default.
    expect(resolvePresetModel("explore", "main:test", "cheap:test", "regolo")).toBe("cheap:test");
  });

  it("keeps independent overrides per provider", async () => {
    const { saveRoleModel } = await import("./config.js");
    saveRoleModel("openrouter", "explore", "z-ai/glm-5.1");
    saveRoleModel("regolo", "explore", "Llama-3.3-70B-Instruct");
    const { resolvePresetModel } = await import("./models.js");
    expect(resolvePresetModel("explore", "main:test", "cheap:test", "openrouter")).toBe("z-ai/glm-5.1");
    expect(resolvePresetModel("explore", "main:test", "cheap:test", "regolo")).toBe("Llama-3.3-70B-Instruct");
  });

  it("migrates a legacy flat override onto the active provider", async () => {
    const { saveConfig, loadConfig } = await import("./config.js");
    // Deliberately write the pre-provider-scoping flat shape (role → model),
    // which the typed API no longer permits, to assert it is migrated on read.
    saveConfig({
      provider: { active: "regolo" },
      models: { roles: { explore: "Llama-3.3-70B-Instruct" } as unknown as Record<string, Record<string, string>> },
    });
    // loadConfig normalizes the legacy flat shape under the active provider.
    expect(loadConfig().models.roles).toEqual({ regolo: { explore: "Llama-3.3-70B-Instruct" } });
    const { resolvePresetModel } = await import("./models.js");
    expect(resolvePresetModel("explore", "main:test", "cheap:test", "regolo")).toBe("Llama-3.3-70B-Instruct");
  });

  it("clears a provider's override without touching another provider's", async () => {
    const { saveRoleModel, loadConfig } = await import("./config.js");
    saveRoleModel("openrouter", "explore", "z-ai/glm-5.1");
    saveRoleModel("regolo", "explore", "Llama-3.3-70B-Instruct");
    saveRoleModel("openrouter", "explore", "default");
    expect(loadConfig().models.roles).toEqual({ regolo: { explore: "Llama-3.3-70B-Instruct" } });
  });
});
