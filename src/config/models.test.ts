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

  it("uses fallbacks when env is unset", async () => {
    delete process.env.ORIN_MODEL;
    delete process.env.ORIN_CHEAP_MODEL;
    const { loadModelConfig } = await import("./models.js");
    expect(loadModelConfig()).toEqual({
      main: "anthropic/claude-sonnet-4.6",
      cheap: "deepseek/deepseek-v4-flash",
    });
  });

  it("reads ORIN_MODEL and ORIN_CHEAP_MODEL from env", async () => {
    process.env.ORIN_MODEL = "openai/gpt-4o";
    process.env.ORIN_CHEAP_MODEL = "meta-llama/llama-3.1-8b-instruct";
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
