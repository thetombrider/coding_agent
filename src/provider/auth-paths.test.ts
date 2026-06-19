import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultProviderAuthIndex,
  providerAuthPaths,
  shouldOpenProviderAuthMenu,
} from "./auth-paths.js";
import type { ProviderSummary } from "./registry.js";

const dualAuth = (overrides: Partial<ProviderSummary>): ProviderSummary => ({
  id: "anthropic",
  displayName: "Anthropic",
  authStrategy: "api-key-or-oauth",
  active: false,
  configured: false,
  ...overrides,
});

describe("auth-paths", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-auth-paths-test-"));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("opens the auth menu when unconfigured or already active", () => {
    expect(shouldOpenProviderAuthMenu(dualAuth({ configured: false }))).toBe(true);
    expect(shouldOpenProviderAuthMenu(dualAuth({ configured: true, active: true }))).toBe(true);
    expect(shouldOpenProviderAuthMenu(dualAuth({ configured: true, active: false }))).toBe(false);
  });

  it("defaults auth menu highlight to configured paths", () => {
    expect(
      defaultProviderAuthIndex([
        { id: "api-key", label: "API key", configured: false },
        { id: "oauth", label: "OAuth", configured: true },
        { id: "oauth-reauth", label: "Sign in again", configured: true },
      ]),
    ).toBe(1);
  });

  it("includes a re-auth row when OAuth tokens exist", async () => {
    const { saveProviderTokens } = await import("./oauth/tokens.js");
    saveProviderTokens("anthropic", {
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
      expiresAt: Date.now() + 3600_000,
    });
    const paths = providerAuthPaths("anthropic");
    expect(paths?.map((p) => p.id)).toEqual(["api-key", "oauth", "oauth-reauth"]);
  });
});
