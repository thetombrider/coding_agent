import { spawn } from "node:child_process";
import { generatePkce, parseOAuthCallbackInput } from "./pkce.js";
import { startLoopbackOAuthServer, type LoopbackOAuthServer } from "./loopback-server.js";
import type { ProviderOAuthTokens } from "./tokens.js";
import { saveProviderTokens } from "./tokens.js";

/** Public Claude CLI OAuth client id (used by community tools for subscription auth). */
export const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const ANTHROPIC_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const ANTHROPIC_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
export const ANTHROPIC_OAUTH_CONSOLE_REDIRECT_URI =
  "https://console.anthropic.com/oauth/code/callback";
export const ANTHROPIC_OAUTH_SCOPES = "org:create_api_key user:profile user:inference";

export type AnthropicOAuthMode = "loopback" | "manual";

export interface AnthropicOAuthSession {
  verifier: string;
  authorizeUrl: string;
  redirectUri: string;
  mode: AnthropicOAuthMode;
  loopback?: LoopbackOAuthServer;
}

export interface AnthropicTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  email?: string;
  subscription_type?: string;
}

export type FetchImpl = typeof fetch;

function buildAuthorizeUrl(
  redirectUri: string,
  pkce: { verifier: string; challenge: string },
): string {
  const url = new URL(ANTHROPIC_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", ANTHROPIC_OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", ANTHROPIC_OAUTH_SCOPES);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);
  return url.toString();
}

/** Open the system browser when possible; otherwise callers should print the URL. */
export function openBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    else if (platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Headless environments fall back to printing the URL.
  }
}

/** Begin OAuth: loopback server or manual paste flow. */
export async function beginAnthropicOAuth(
  mode: AnthropicOAuthMode = "manual",
): Promise<AnthropicOAuthSession> {
  const pkce = generatePkce();

  if (mode === "loopback") {
    const loopback = await startLoopbackOAuthServer();
    return {
      verifier: pkce.verifier,
      redirectUri: loopback.redirectUri,
      authorizeUrl: buildAuthorizeUrl(loopback.redirectUri, pkce),
      mode,
      loopback,
    };
  }

  return {
    verifier: pkce.verifier,
    redirectUri: ANTHROPIC_OAUTH_CONSOLE_REDIRECT_URI,
    authorizeUrl: buildAuthorizeUrl(ANTHROPIC_OAUTH_CONSOLE_REDIRECT_URI, pkce),
    mode,
  };
}

/** Exchange an authorization code for OAuth tokens. */
export async function exchangeAnthropicOAuthCode(
  code: string,
  verifier: string,
  redirectUri: string,
  state?: string,
  fetchImpl: FetchImpl = fetch,
): Promise<ProviderOAuthTokens> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  };
  if (state) body.state = state;

  const response = await fetchImpl(ANTHROPIC_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Anthropic OAuth token exchange failed: ${response.status}${detail ? ` — ${detail}` : ""}`,
    );
  }

  const json = (await response.json()) as AnthropicTokenResponse;
  return tokensFromResponse(json);
}

/** Refresh OAuth tokens when the access token is near expiry. */
export async function refreshAnthropicOAuthTokens(
  refreshToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<ProviderOAuthTokens> {
  const response = await fetchImpl(ANTHROPIC_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Anthropic OAuth refresh failed: ${response.status}${detail ? ` — ${detail}` : ""}`,
    );
  }

  const json = (await response.json()) as AnthropicTokenResponse;
  return tokensFromResponse(json, refreshToken);
}

function tokensFromResponse(
  json: AnthropicTokenResponse,
  fallbackRefresh?: string,
): ProviderOAuthTokens {
  const expiresAt =
    typeof json.expires_in === "number"
      ? Date.now() + json.expires_in * 1000
      : undefined;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? fallbackRefresh,
    expiresAt,
    email: json.email,
    subscriptionType: json.subscription_type,
  };
}

/** Parse pasted callback input and exchange for tokens. */
export async function completeAnthropicOAuthPaste(
  session: AnthropicOAuthSession,
  pasted: string,
  fetchImpl: FetchImpl = fetch,
): Promise<ProviderOAuthTokens> {
  const { code, state } = parseOAuthCallbackInput(pasted);
  return exchangeAnthropicOAuthCode(
    code,
    session.verifier,
    session.redirectUri,
    state,
    fetchImpl,
  );
}

/** Persist Anthropic OAuth tokens under the `anthropic` provider key. */
export function storeAnthropicOAuthTokens(tokens: ProviderOAuthTokens): void {
  saveProviderTokens("anthropic", tokens);
}

/** Policy note shown before subscription OAuth in the TUI. */
export const ANTHROPIC_OAUTH_POLICY_NOTE =
  "Anthropic subscription OAuth is intended for personal experimentation. "
  + "For production use, prefer an Anthropic Console API key (sk-ant-…). "
  + "Third-party OAuth may violate Anthropic consumer terms — confirm current policy before proceeding.";
