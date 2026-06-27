import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ensureConfigFile", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-config-test-"));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("creates a populated config when the file is missing", async () => {
    const { ensureConfigFile } = await import("./config.js");
    expect(ensureConfigFile()).toBe(true);

    const raw = readFileSync(join(home, ".orin", "config.json"), "utf8");
    const parsed = JSON.parse(raw) as { models: { providers: Record<string, unknown> }; provider: { active: string } };
    expect(parsed.models.providers).toEqual({});
    expect(parsed.provider.active).toBe("openrouter");
    expect(raw.length).toBeGreaterThan(10);
  });

  it("replaces an empty config file", async () => {
    const configDir = join(home, ".orin");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.json");
    writeFileSync(configPath, "", "utf8");

    const { ensureConfigFile } = await import("./config.js");
    expect(ensureConfigFile()).toBe(true);

    const raw = readFileSync(configPath, "utf8").trim();
    expect(raw).not.toBe("");
    expect(JSON.parse(raw).models.providers).toEqual({});
  });

  it("leaves a non-empty config file untouched", async () => {
    const configDir = join(home, ".orin");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ models: { main: "custom/model" } }) + "\n", "utf8");

    const { ensureConfigFile, loadConfig } = await import("./config.js");
    expect(ensureConfigFile()).toBe(false);

    expect(loadConfig().models.providers.openrouter?.main).toBe("custom/model");
  });

  it("migrates a legacy flat picker array to openrouter-scoped overrides", async () => {
    const configDir = join(home, ".orin");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ models: { picker: ["legacy/model-a", "legacy/model-b"] } }) + "\n",
      "utf8",
    );

    const { loadConfig } = await import("./config.js");
    expect(loadConfig().models.providers.openrouter?.pickerExtras).toEqual([
      "legacy/model-a",
      "legacy/model-b",
    ]);
  });

  it("drops legacy bundled openrouter picker overrides so new defaults apply", async () => {
    const configDir = join(home, ".orin");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
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
      }) + "\n",
      "utf8",
    );

    const { loadConfig } = await import("./config.js");
    expect(loadConfig().models.providers).toEqual({});
  });
});

describe("API key onboarding", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-config-key-"));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("reports no key when config does not provide one", async () => {
    const { hasOpenRouterApiKey } = await import("./config.js");
    expect(hasOpenRouterApiKey()).toBe(false);
  });

  it("persists a key to config.json and reads it back from any directory", async () => {
    const { saveConfig, hasOpenRouterApiKey, loadConfig } = await import("./config.js");
    saveConfig({ provider: { openrouter: { apiKey: "sk-saved" } } });

    expect(hasOpenRouterApiKey()).toBe(true);
    expect(loadConfig().provider.openrouter?.apiKey).toBe("sk-saved");

    const raw = readFileSync(join(home, ".orin", "config.json"), "utf8");
    expect(JSON.parse(raw).provider.openrouter.apiKey).toBe("sk-saved");
  });

  it("persists an Anthropic key to config.json", async () => {
    const { saveConfig, hasAnthropicApiKey, loadConfig } = await import("./config.js");
    saveConfig({ provider: { anthropic: { apiKey: "sk-ant-saved" } } });

    expect(hasAnthropicApiKey()).toBe(true);
    expect(loadConfig().provider.anthropic?.apiKey).toBe("sk-ant-saved");
  });

  it("persists a Regolo key to config.json", async () => {
    const { saveConfig, hasRegoloApiKey, loadConfig } = await import("./config.js");
    saveConfig({ provider: { regolo: { apiKey: "sk-regolo" } } });

    expect(hasRegoloApiKey()).toBe(true);
    expect(loadConfig().provider.regolo?.apiKey).toBe("sk-regolo");
  });

  it("saveProviderConfig writes provider-specific fields", async () => {
    const { saveProviderConfig, loadConfig } = await import("./config.js");
    saveProviderConfig("openrouter", { apiKey: "  sk-trimmed  " });

    expect(loadConfig().provider.openrouter?.apiKey).toBe("sk-trimmed");

    const raw = readFileSync(join(home, ".orin", "config.json"), "utf8");
    expect(JSON.parse(raw).provider.openrouter.apiKey).toBe("sk-trimmed");
  });

  it("reports no E2B key when config does not provide one", async () => {
    const { hasE2BApiKey } = await import("./config.js");
    expect(hasE2BApiKey()).toBe(false);
  });

  it("persists an E2B key to config.json", async () => {
    const { saveConfig, hasE2BApiKey, loadConfig } = await import("./config.js");
    saveConfig({ sandbox: { e2b: { apiKey: "e2b-saved" } } });

    expect(hasE2BApiKey()).toBe(true);
    expect(loadConfig().sandbox?.e2b?.apiKey).toBe("e2b-saved");

    const raw = readFileSync(join(home, ".orin", "config.json"), "utf8");
    expect(JSON.parse(raw).sandbox.e2b.apiKey).toBe("e2b-saved");
  });

  it("saveE2BApiKey trims and persists the key", async () => {
    const { saveE2BApiKey, hasE2BApiKey, loadConfig } = await import("./config.js");
    saveE2BApiKey("  e2b-trimmed  ");

    expect(hasE2BApiKey()).toBe(true);
    expect(loadConfig().sandbox?.e2b?.apiKey).toBe("e2b-trimmed");
  });

  it("saveExaApiKey trims and persists the key", async () => {
    const { saveExaApiKey, hasExaApiKey, loadConfig } = await import("./config.js");
    saveExaApiKey("  exa-trimmed  ");

    expect(hasExaApiKey()).toBe(true);
    expect(loadConfig().tools?.exa?.apiKey).toBe("exa-trimmed");
  });
});
