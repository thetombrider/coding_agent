import type { McpHttpConfig, McpServerConfig } from "./config.js";

export type McpOAuthOptions = {
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
};

export function parseMcpOAuth(raw: unknown): true | McpOAuthOptions | undefined {
  if (raw === undefined) return undefined;
  if (raw === true) return true;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const scopes = Array.isArray(o.scopes)
    ? o.scopes.filter((s): s is string => typeof s === "string")
    : undefined;
  return {
    clientId: typeof o.clientId === "string" ? o.clientId : undefined,
    clientSecret: typeof o.clientSecret === "string" ? o.clientSecret : undefined,
    scopes: scopes?.length ? scopes : undefined,
  };
}

export function resolveMcpOAuthOptions(
  config: McpHttpConfig,
): McpOAuthOptions | undefined {
  if (config.oauth === undefined) return undefined;
  if (config.oauth === true) return {};
  return config.oauth;
}

/** Whether OAuth is explicitly enabled in mcp.json (`"oauth": true` or `"oauth": { … }`). */
export function isMcpOAuthConfigured(config: McpServerConfig): boolean {
  return config.type === "http" && config.oauth !== undefined;
}

export function mcpOAuthAuthHint(_serverName?: string): string {
  return "Press a in /mcp detail to Authenticate (opens browser).";
}

export function mcpOAuthSetupHint(_serverName?: string): string {
  return "Press a in /mcp detail to enable OAuth and authenticate, or Enter to edit auth settings.";
}
