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
    expect(parsed.models.main).toBe("anthropic/claude-sonnet-4");
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
    expect(JSON.parse(raw).models.main).toBe("anthropic/claude-sonnet-4");
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
});

describe("API key onboarding", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevKey: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevKey = process.env.OPENROUTER_API_KEY;
    home = mkdtempSync(join(tmpdir(), "orin-config-key-"));
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
});
