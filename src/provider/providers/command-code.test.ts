import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig, __testClearCache } from "../../config/config.js";

describe("command-code provider", () => {
  let prevHome: string | undefined;
  let home: string;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-command-code-test-"));
    process.env.HOME = home;
    __testClearCache();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    __testClearCache();
    rmSync(home, { recursive: true, force: true });
  });

  it("reports unconfigured without credentials", async () => {
    const { commandCodeProvider: provider } = await import("./command-code.js");
    expect(provider.isConfigured()).toBe(false);
  });

  it("reports configured when the config key is set", async () => {
    saveConfig({ provider: { "command-code": { apiKey: "sk-cmd-test" } } });
    const { commandCodeProvider: provider } = await import("./command-code.js");
    expect(provider.isConfigured()).toBe(true);
  });

  it("has correct provider id and display name", async () => {
    const { commandCodeProvider: provider } = await import("./command-code.js");
    expect(provider.id).toBe("command-code");
    expect(provider.displayName).toBe("Command Code");
    expect(provider.authStrategy).toBe("api-key");
    expect(provider.configSection).toBe("command-code");
  });

  it("normalizes model ids by stripping the prefix", async () => {
    const { commandCodeProvider: provider } = await import("./command-code.js");
    expect(provider.normalizeModelId("command-code:deepseek/deepseek-v4-flash")).toBe("deepseek/deepseek-v4-flash");
    expect(provider.normalizeModelId("deepseek/deepseek-v4-flash")).toBe("deepseek/deepseek-v4-flash");
    expect(provider.normalizeModelId("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("routes Anthropic models through the anthropic client", async () => {
    saveConfig({ provider: { "command-code": { apiKey: "sk-cmd-test" } } });
    const { commandCodeProvider: provider } = await import("./command-code.js");
    const model = provider.languageModel("claude-sonnet-4-6");
    expect(model).toBeDefined();
    expect(model.modelId).toBe("claude-sonnet-4-6");
  });

  it("routes non-Anthropic models through the openai client", async () => {
    saveConfig({ provider: { "command-code": { apiKey: "sk-cmd-test" } } });
    const { commandCodeProvider: provider } = await import("./command-code.js");
    const model = provider.languageModel("deepseek/deepseek-v4-flash");
    expect(model).toBeDefined();
    expect(model.modelId).toBe("deepseek/deepseek-v4-flash");
  });

  it("is registered in the provider registry", async () => {
    const { getProvider, providerSummaries } = await import("../registry.js");
    const found = getProvider("command-code");
    expect(found).toBeDefined();
    expect(found!.id).toBe("command-code");
    expect(providerSummaries().some((p) => p.id === "command-code")).toBe(true);
  });

  it("has exposed config fields", async () => {
    const { providerConfigFields } = await import("../registry.js");
    const fields = providerConfigFields("command-code");
    expect(fields.length).toBe(1);
    expect(fields[0]!.key).toBe("apiKey");
    expect(fields[0]!.secret).toBe(true);
  });

  it("has picker models", async () => {
    const { commandCodeProvider: provider } = await import("./command-code.js");
    expect(provider.pickerModels.length).toBeGreaterThan(10);
    expect(provider.pickerModels).toContain("deepseek/deepseek-v4-flash");
    expect(provider.pickerModels).toContain("claude-sonnet-5");
  });

  it("has default slots", async () => {
    const { commandCodeProvider: provider } = await import("./command-code.js");
    expect(provider.defaultSlots.main).toBe("deepseek/deepseek-v4-flash");
    expect(provider.defaultSlots.explore).toBeDefined();
    expect(provider.defaultSlots.delegate_read).toBeDefined();
    expect(provider.defaultSlots.compaction).toBeDefined();
  });
});
