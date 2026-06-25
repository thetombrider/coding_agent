import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { regoloProvider } from "./regolo.js";

describe("regolo provider", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-regolo-test-"));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("reports unconfigured without credentials", () => {
    expect(regoloProvider.isConfigured()).toBe(false);
  });

  it("reports configured when the config key is set", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { regolo: { apiKey: "sk-regolo" } } });
    vi.resetModules();
    const { regoloProvider: provider } = await import("./regolo.js");
    expect(provider.isConfigured()).toBe(true);
  });

  it("exposes api-key config fields", () => {
    expect(regoloProvider.configFields).toEqual([
      {
        key: "apiKey",
        label: "Regolo AI API key",
        secret: true,
      },
    ]);
  });

  it("returns a language model handle when configured", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { regolo: { apiKey: "sk-regolo" } } });
    vi.resetModules();
    const { regoloProvider: provider } = await import("./regolo.js");
    const model = provider.languageModel("Llama-3.3-70B-Instruct");
    expect(model).toBeDefined();
    expect(typeof model).toBe("object");
  });

  it("is registered in the provider registry", async () => {
    const { getProvider, providerSummaries } = await import("../registry.js");
    expect(getProvider("regolo")?.id).toBe("regolo");
    expect(providerSummaries().some((p) => p.id === "regolo")).toBe(true);
  });
});
