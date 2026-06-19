import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** OAuth tokens for a single provider backend. */
export interface ProviderOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  email?: string;
  subscriptionType?: string;
}

export type TokenStore = Partial<Record<string, ProviderOAuthTokens>>;

function tokensPath(): string {
  return join(homedir(), ".orin", "tokens.json");
}

function readRawTokens(): TokenStore {
  const path = tokensPath();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw) as TokenStore;
  } catch {
    return {};
  }
}

/** Load all OAuth tokens from ~/.orin/tokens.json. */
export function loadTokens(): TokenStore {
  return readRawTokens();
}

/** Load OAuth tokens for one provider id. */
export function loadProviderTokens(providerId: string): ProviderOAuthTokens | undefined {
  return readRawTokens()[providerId];
}

/** Persist OAuth tokens for one provider (file mode 0600). */
export function saveProviderTokens(providerId: string, tokens: ProviderOAuthTokens): void {
  const path = tokensPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const next = { ...readRawTokens(), [providerId]: tokens };
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on platforms that ignore mode bits.
  }
}

/** Remove OAuth tokens for one provider. */
export function clearProviderTokens(providerId: string): void {
  const path = tokensPath();
  const current = readRawTokens();
  if (!(providerId in current)) return;
  delete current[providerId];
  if (Object.keys(current).length === 0) {
    if (existsSync(path)) writeFileSync(path, "{}\n", { mode: 0o600 });
    return;
  }
  writeFileSync(path, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
}

/** True when access token exists and is not expired (with optional skew). */
export function hasValidOAuthTokens(
  tokens: ProviderOAuthTokens | undefined,
  skewMs = 0,
): boolean {
  if (!tokens?.accessToken?.trim()) return false;
  if (tokens.expiresAt === undefined) return true;
  return tokens.expiresAt > Date.now() + skewMs;
}
