import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePkce, parseOAuthCallbackInput } from "./pkce.js";
import {
  ANTHROPIC_OAUTH_CONSOLE_REDIRECT_URI,
  beginAnthropicOAuth,
} from "./anthropic-oauth.js";

describe("anthropic oauth session", () => {
  it("uses the Anthropic Console redirect URI for manual flow", async () => {
    const session = await beginAnthropicOAuth("manual");
    expect(session.mode).toBe("manual");
    expect(session.redirectUri).toBe(ANTHROPIC_OAUTH_CONSOLE_REDIRECT_URI);
    expect(session.authorizeUrl).toContain(
      encodeURIComponent(ANTHROPIC_OAUTH_CONSOLE_REDIRECT_URI),
    );
    expect(session.loopback).toBeUndefined();
  });
});

describe("pkce", () => {
  it("generates a verifier/challenge pair", () => {
    const pkce = generatePkce();
    expect(pkce.verifier.length).toBeGreaterThan(20);
    expect(pkce.challenge.length).toBeGreaterThan(20);
    expect(pkce.verifier).not.toBe(pkce.challenge);
  });

  it("parses pasted callback input with optional state", () => {
    expect(parseOAuthCallbackInput("abc123")).toEqual({ code: "abc123" });
    expect(parseOAuthCallbackInput("abc123#state-token")).toEqual({
      code: "abc123",
      state: "state-token",
    });
  });
});

describe("tokens store", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-tokens-test-"));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("persists and loads provider tokens", async () => {
    const { saveProviderTokens, loadProviderTokens, hasValidOAuthTokens } = await import("./tokens.js");
    saveProviderTokens("anthropic", {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 60_000,
    });

    const loaded = loadProviderTokens("anthropic");
    expect(loaded?.accessToken).toBe("access-1");
    expect(hasValidOAuthTokens(loaded)).toBe(true);

    const raw = readFileSync(join(home, ".orin", "tokens.json"), "utf8");
    expect(JSON.parse(raw).anthropic.accessToken).toBe("access-1");
  });

  it("clears provider tokens", async () => {
    const { saveProviderTokens, clearProviderTokens, loadProviderTokens } = await import("./tokens.js");
    saveProviderTokens("anthropic", { accessToken: "x" });
    clearProviderTokens("anthropic");
    expect(loadProviderTokens("anthropic")).toBeUndefined();
  });
});
