import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface McpOAuthStore {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

function secretsDir(): string {
  return join(homedir(), ".orin", "secrets", "mcp");
}

export function mcpOAuthStorePath(serverName: string): string {
  return join(secretsDir(), `${serverName}.json`);
}

export function readMcpOAuthStore(serverName: string): McpOAuthStore | undefined {
  const path = mcpOAuthStorePath(serverName);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as McpOAuthStore;
  } catch {
    return undefined;
  }
}

export function writeMcpOAuthStore(serverName: string, store: McpOAuthStore): void {
  const path = mcpOAuthStorePath(serverName);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

export function updateMcpOAuthStore(
  serverName: string,
  patch: Partial<McpOAuthStore>,
): McpOAuthStore {
  const next = { ...(readMcpOAuthStore(serverName) ?? {}), ...patch };
  writeMcpOAuthStore(serverName, next);
  return next;
}

export function deleteMcpOAuthStore(serverName: string): void {
  const path = mcpOAuthStorePath(serverName);
  if (existsSync(path)) rmSync(path, { force: true });
}

export function hasMcpOAuthSession(serverName: string): boolean {
  const store = readMcpOAuthStore(serverName);
  return Boolean(store?.tokens?.access_token || store?.tokens?.refresh_token);
}
