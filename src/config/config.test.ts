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
    const parsed = JSON.parse(raw) as { models: { main: string }; provider: { active: string } };
    expect(parsed.models.main).toBe("anthropic/claude-sonnet-4.6");
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
    expect(JSON.parse(raw).models.main).toBe("anthropic/claude-sonnet-4.6");
  });

  it("leaves a non-empty config file untouched", async () => {
    const configDir = join(home, ".orin");
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ models: { main: "custom/model" } }) + "\n", "utf8");

    const { ensureConfigFile } = await import("./config.js");
    expect(ensureConfigFile()).toBe(false);

    const raw = readFileSync(configPath, "utf8");
    expect(JSON.parse(raw).models.main).toBe("custom/model");
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
    expect(loadConfig().models.picker).toEqual({
      openrouter: ["legacy/model-a", "legacy/model-b"],
    });
  });
});

describe("API key onboarding", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevKey: string | undefined;
  let prevRegoloKey: string | undefined;
  let prevE2BKey: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevKey = process.env.OPENROUTER_API_KEY;
    prevRegoloKey = process.env.REGOLO_API_KEY;
    prevE2BKey = process.env.E2B_API_KEY;
    home = mkdtempSync(join(tmpdir(), "orin-config-key-"));
    process.env.HOME = home;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.REGOLO_API_KEY;
    delete process.env.E2B_API_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
    if (prevRegoloKey === undefined) delete process.env.REGOLO_API_KEY;
    else process.env.REGOLO_API_KEY = prevRegoloKey;
    if (prevE2BKey === undefined) delete process.env.E2B_API_KEY;
    else process.env.E2B_API_KEY = prevE2BKey;
    rmSync(home, { recursive: true, force: true });
  });

  it("reports no key when neither env nor config provide one", async () => {
    const { hasOpenRouterApiKey } = await import("./config.js");
    expect(hasOpenRouterApiKey()).toBe(false);
  });

  it("detects a key from the env var", async () => {
    process.env.OPENROUTER_API_KEY = "sk-env";
    const { hasOpenRouterApiKey } = await import("./config.js");
    expect(hasOpenRouterApiKey()).toBe(true);
  });

  it("persists a key to config.json and reads it back from any directory", async () => {
    const { saveConfig, hasOpenRouterApiKey, loadConfig } = await import("./config.js");
    saveConfig({ provider: { openrouter: { apiKey: "sk-saved" } } });

    expect(hasOpenRouterApiKey()).toBe(true);
    expect(loadConfig().provider.openrouter?.apiKey).toBe("sk-saved");

    const raw = readFileSync(join(home, ".orin", "config.json"), "utf8");
    expect(JSON.parse(raw).provider.openrouter.apiKey).toBe("sk-saved");
  });

  it("detects a Regolo key from the env var", async () => {
    process.env.REGOLO_API_KEY = "sk-regolo";
    const { hasRegoloApiKey } = await import("./config.js");
    expect(hasRegoloApiKey()).toBe(true);
  });

  it("env var overrides Regolo config file api key", async () => {
    const { saveConfig, loadConfig } = await import("./config.js");
    saveConfig({ provider: { regolo: { apiKey: "sk-config" } } });
    process.env.REGOLO_API_KEY = "sk-env";
    expect(loadConfig().provider.regolo?.apiKey).toBe("sk-env");
  });

  it("saveProviderConfig writes provider-specific fields", async () => {
    const { saveProviderConfig, loadConfig } = await import("./config.js");
    saveProviderConfig("openrouter", { apiKey: "  sk-trimmed  " });

    expect(loadConfig().provider.openrouter?.apiKey).toBe("sk-trimmed");

    const raw = readFileSync(join(home, ".orin", "config.json"), "utf8");
    expect(JSON.parse(raw).provider.openrouter.apiKey).toBe("sk-trimmed");
  });

  it("reports no E2B key when neither env nor config provide one", async () => {
    const { hasE2BApiKey } = await import("./config.js");
    expect(hasE2BApiKey()).toBe(false);
  });

  it("detects an E2B key from the env var", async () => {
    process.env.E2B_API_KEY = "e2b-test";
    const { hasE2BApiKey } = await import("./config.js");
    expect(hasE2BApiKey()).toBe(true);
  });

  it("persists an E2B key to config.json", async () => {
    const { saveConfig, hasE2BApiKey, loadConfig } = await import("./config.js");
    saveConfig({ sandbox: { e2b: { apiKey: "e2b-saved" } } });

    expect(hasE2BApiKey()).toBe(true);
    expect(loadConfig().sandbox?.e2b?.apiKey).toBe("e2b-saved");

    const raw = readFileSync(join(home, ".orin", "config.json"), "utf8");
    expect(JSON.parse(raw).sandbox.e2b.apiKey).toBe("e2b-saved");
  });
});
