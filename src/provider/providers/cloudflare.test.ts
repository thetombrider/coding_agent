import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLOUDFLARE_PICKER_MODELS,
  cloudflareBaseURL,
  cloudflareProvider,
} from "./cloudflare.js";
import { resetModelsDevCache } from "../modelsdev.js";

const TEST_API_KEY = "test-cloudflare-key";
const TEST_ACCOUNT_ID = "test-account-id";
const TEST_GATEWAY_ID = "my-gateway";

function mockModelsDevFetch(body: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("models.dev/api.json")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        json: async () => body,
      };
    }
    return {
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: { get: () => null },
      json: async () => ({}),
    };
  }) as unknown as typeof fetch;
}

describe("cloudflare provider", () => {
  let home: string;
  let prevHome: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-cloudflare-test-"));
    process.env.HOME = home;
    originalFetch = globalThis.fetch;
    resetModelsDevCache();
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    globalThis.fetch = originalFetch;
    resetModelsDevCache();
    rmSync(home, { recursive: true, force: true });
  });

  it("lists curated gateway models in the picker", () => {
    expect(CLOUDFLARE_PICKER_MODELS).toContain("anthropic/claude-sonnet-4.6");
    expect(CLOUDFLARE_PICKER_MODELS).toContain("openai/gpt-5.4-mini");
  });

  it("builds the OpenAI-compatible compat base URL", () => {
    expect(cloudflareBaseURL(TEST_ACCOUNT_ID)).toBe(
      "https://gateway.ai.cloudflare.com/v1/test-account-id/default/compat",
    );
    expect(cloudflareBaseURL(TEST_ACCOUNT_ID, TEST_GATEWAY_ID)).toBe(
      "https://gateway.ai.cloudflare.com/v1/test-account-id/my-gateway/compat",
    );
  });

  it("reports unconfigured without credentials", () => {
    expect(cloudflareProvider.isConfigured()).toBe(false);
  });

  it("reports unconfigured when only the API key is set", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { cloudflare: { apiKey: TEST_API_KEY } } });
    vi.resetModules();
    const { cloudflareProvider: provider } = await import("./cloudflare.js");
    expect(provider.isConfigured()).toBe(false);
  });

  it("reports configured when api key and account id are set", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({
      provider: {
        cloudflare: { apiKey: TEST_API_KEY, accountId: TEST_ACCOUNT_ID },
      },
    });
    vi.resetModules();
    const { cloudflareProvider: provider } = await import("./cloudflare.js");
    expect(provider.isConfigured()).toBe(true);
  });

  it("normalizes cloudflare-prefixed model ids", () => {
    expect(cloudflareProvider.normalizeModelId("cloudflare:openai/gpt-5.4-mini")).toBe(
      "openai/gpt-5.4-mini",
    );
  });

  it("exposes cloudflare config fields", () => {
    expect(cloudflareProvider.configFields).toEqual([
      {
        key: "apiKey",
        label: "Cloudflare API token",
        secret: true,
      },
      {
        key: "accountId",
        label: "Cloudflare account ID",
      },
      {
        key: "gatewayId",
        label: "AI Gateway ID (default: default)",
      },
    ]);
  });

  it("returns a language model handle when configured", async () => {
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({
      provider: {
        cloudflare: {
          apiKey: TEST_API_KEY,
          accountId: TEST_ACCOUNT_ID,
          gatewayId: TEST_GATEWAY_ID,
        },
      },
    });
    vi.resetModules();
    const { cloudflareProvider: provider } = await import("./cloudflare.js");
    const model = provider.languageModel("anthropic/claude-sonnet-4.6");
    expect(model).toBeDefined();
    expect(typeof model).toBe("object");
  });

  it("is registered in the provider registry", async () => {
    const { getProvider, providerSummaries } = await import("../registry.js");
    expect(getProvider("cloudflare")?.id).toBe("cloudflare");
    expect(providerSummaries().some((p) => p.id === "cloudflare")).toBe(true);
  });

  it("accepts provider/model ids for supportsModel", () => {
    expect(cloudflareProvider.metadata.supportsModel("anthropic/claude-sonnet-4.6")).toBe(true);
    expect(cloudflareProvider.metadata.supportsModel("cloudflare:openai/gpt-5.4-mini")).toBe(true);
    expect(cloudflareProvider.metadata.supportsModel("gpt-5.4-mini")).toBe(false);
  });

  it("resolves context windows from the models.dev cloudflare entry", async () => {
    const catalog = {
      cloudflare: {
        id: "cloudflare",
        models: {
          "anthropic/claude-sonnet-4.6": {
            id: "anthropic/claude-sonnet-4.6",
            limit: { context: 1_000_000, output: 64_000 },
          },
        },
      },
    };
    globalThis.fetch = mockModelsDevFetch(catalog);

    const { saveConfig } = await import("../../config/config.js");
    saveConfig({
      provider: {
        cloudflare: { apiKey: TEST_API_KEY, accountId: TEST_ACCOUNT_ID },
      },
    });
    vi.resetModules();
    const { cloudflareProvider: provider } = await import("./cloudflare.js");
    await expect(provider.metadata.getContextWindow("anthropic/claude-sonnet-4.6")).resolves.toBe(
      1_000_000,
    );
    await expect(provider.metadata.getContextWindow("does-not-exist")).resolves.toBeUndefined();
  });

  it("falls back to upstream provider context windows", async () => {
    const catalog = {
      openai: {
        id: "openai",
        models: {
          "gpt-5.4-mini": {
            id: "gpt-5.4-mini",
            limit: { context: 400_000, output: 128_000 },
          },
        },
      },
    };
    globalThis.fetch = mockModelsDevFetch(catalog);

    const { saveConfig } = await import("../../config/config.js");
    saveConfig({
      provider: {
        cloudflare: { apiKey: TEST_API_KEY, accountId: TEST_ACCOUNT_ID },
      },
    });
    vi.resetModules();
    const { cloudflareProvider: provider } = await import("./cloudflare.js");
    await expect(provider.metadata.getContextWindow("openai/gpt-5.4-mini")).resolves.toBe(400_000);
  });
});
