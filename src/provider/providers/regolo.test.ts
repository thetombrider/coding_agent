import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { regoloProvider } from "./regolo.js";

describe("regolo provider", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevKey: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevKey = process.env.REGOLO_API_KEY;
    home = mkdtempSync(join(tmpdir(), "orin-regolo-test-"));
    process.env.HOME = home;
    delete process.env.REGOLO_API_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevKey === undefined) delete process.env.REGOLO_API_KEY;
    else process.env.REGOLO_API_KEY = prevKey;
    rmSync(home, { recursive: true, force: true });
  });

  it("reports unconfigured without credentials", () => {
    expect(regoloProvider.isConfigured()).toBe(false);
  });

  it("reports configured when the env key is set", () => {
    process.env.REGOLO_API_KEY = "sk-regolo";
    expect(regoloProvider.isConfigured()).toBe(true);
  });

  it("exposes api-key config fields", () => {
    expect(regoloProvider.configFields).toEqual([
      {
        key: "apiKey",
        label: "Regolo AI API key",
        secret: true,
        envVar: "REGOLO_API_KEY",
      },
    ]);
  });

  it("returns a language model handle when configured", () => {
    process.env.REGOLO_API_KEY = "sk-regolo";
    const model = regoloProvider.languageModel("Llama-3.3-70B-Instruct");
    expect(model).toBeDefined();
    expect(typeof model).toBe("object");
  });

  it("is registered in the provider registry", async () => {
    const { getProvider, providerSummaries } = await import("../registry.js");
    expect(getProvider("regolo")?.id).toBe("regolo");
    expect(providerSummaries().some((p) => p.id === "regolo")).toBe(true);
  });
});
