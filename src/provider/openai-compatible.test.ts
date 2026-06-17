import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpenAiCompatibleProvider,
  loadOpenAiCompatibleModelsCatalog,
  lookupOpenAiCompatibleContextWindow,
  resetOpenAiCompatibleModelsCache,
} from "./openai-compatible.js";

const SAMPLE_CATALOG = {
  data: [
    { id: "Llama-3.3-70B-Instruct", context_length: 131072 },
    { id: "Llama-3.1-8B-Instruct", context_window: 32000 },
  ],
};

const testCfg = {
  id: "regolo",
  displayName: "Regolo AI",
  envVar: "REGOLO_API_KEY",
  configSection: "regolo" as const,
  baseURL: "https://api.regolo.ai/v1",
  idPrefix: "regolo:",
  pickerModels: ["Llama-3.3-70B-Instruct", "Llama-3.1-8B-Instruct"],
};

function mockFetch(handlers: Record<string, { ok?: boolean; status?: number; body: unknown }>) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    const handler = Object.entries(handlers).find(([pattern]) => url.includes(pattern))?.[1];
    if (!handler) {
      return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
    }
    const ok = handler.ok ?? true;
    const status = handler.status ?? (ok ? 200 : 500);
    return {
      ok,
      status,
      statusText: ok ? "OK" : "Error",
      json: async () => handler.body,
    };
  }) as unknown as typeof fetch;
}

describe("openai-compatible", () => {
  let home: string;
  let prevHome: string | undefined;
  let prevKey: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevKey = process.env.REGOLO_API_KEY;
    home = mkdtempSync(join(tmpdir(), "orin-openai-compat-test-"));
    process.env.HOME = home;
    delete process.env.REGOLO_API_KEY;
    resetOpenAiCompatibleModelsCache();
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevKey === undefined) delete process.env.REGOLO_API_KEY;
    else process.env.REGOLO_API_KEY = prevKey;
    rmSync(home, { recursive: true, force: true });
    resetOpenAiCompatibleModelsCache();
  });

  it("resolves credentials from env before config", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ provider: { regolo: { apiKey: "sk-config" } } });
    process.env.REGOLO_API_KEY = "sk-env";

    const provider = createOpenAiCompatibleProvider(testCfg);
    expect(provider.isConfigured()).toBe(true);
  });

  it("reads credentials from config when env is unset", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ provider: { regolo: { apiKey: "sk-config" } } });

    const provider = createOpenAiCompatibleProvider(testCfg);
    expect(provider.isConfigured()).toBe(true);
  });

  it("strips optional id prefixes", () => {
    const provider = createOpenAiCompatibleProvider(testCfg);
    expect(provider.normalizeModelId("regolo:Llama-3.3-70B-Instruct")).toBe("Llama-3.3-70B-Instruct");
    expect(provider.normalizeModelId("Llama-3.3-70B-Instruct")).toBe("Llama-3.3-70B-Instruct");
  });

  it("loads and caches the models catalog", async () => {
    const fetchImpl = mockFetch({ "/v1/models": { body: SAMPLE_CATALOG } });
    const first = await loadOpenAiCompatibleModelsCatalog(testCfg, fetchImpl, "sk-test");
    const second = await loadOpenAiCompatibleModelsCatalog(testCfg, fetchImpl, "sk-test");

    expect(first.get("Llama-3.3-70B-Instruct")).toBe(131072);
    expect(second.get("Llama-3.1-8B-Instruct")).toBe(32000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls;
    expect(String(calls[0]?.[0])).toBe("https://api.regolo.ai/v1/models");
    expect(calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer sk-test" },
    });
  });

  it("looks up context windows from the catalog", async () => {
    const fetchImpl = mockFetch({ "/v1/models": { body: SAMPLE_CATALOG } });
    await expect(
      lookupOpenAiCompatibleContextWindow(testCfg, "regolo:Llama-3.3-70B-Instruct", fetchImpl, "sk-test"),
    ).resolves.toBe(131072);
  });

  it("returns undefined when the catalog fetch fails", async () => {
    const fetchImpl = mockFetch({ "/v1/models": { ok: false, status: 500, body: {} } });
    await expect(
      lookupOpenAiCompatibleContextWindow(testCfg, "unknown-model", fetchImpl),
    ).resolves.toBeUndefined();
  });
});
