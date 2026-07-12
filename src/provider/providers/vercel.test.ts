import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERCEL_PICKER_MODELS, vercelProvider } from "./vercel.js";

const TEST_API_KEY = "test-vercel-key";

describe("vercel provider", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-vercel-test-"));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("lists curated gateway models in the picker", () => {
    expect(VERCEL_PICKER_MODELS).toContain("anthropic/claude-sonnet-4.6");
    expect(VERCEL_PICKER_MODELS).toContain("openai/gpt-5.4-mini");
  });

  it("reports unconfigured without credentials", () => {
    expect(vercelProvider.isConfigured()).toBe(false);
  });

  it("reports configured when the config key is set", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { vercel: { apiKey: TEST_API_KEY } } });
    vi.resetModules();
    const { vercelProvider: provider } = await import("./vercel.js");
    expect(provider.isConfigured()).toBe(true);
  });

  it("normalizes vercel-prefixed model ids", () => {
    expect(vercelProvider.normalizeModelId("vercel:openai/gpt-5.4-mini")).toBe("openai/gpt-5.4-mini");
  });

  it("exposes api-key config fields", () => {
    expect(vercelProvider.configFields).toEqual([
      {
        key: "apiKey",
        label: "Vercel AI Gateway API key",
        secret: true,
      },
    ]);
  });
});
