import type { McpServerConfig } from "./config.js";
import { isMcpOAuthConfigured, mcpOAuthAuthHint, mcpOAuthSetupHint } from "./oauth-config.js";
import { hasMcpAuth } from "./wizard.js";

export type McpConnectionStatus = "connected" | "needs_auth" | "failed" | "disabled";

export interface McpFailureInfo {
  status: "needs_auth" | "failed";
  reason: string;
  hint?: string;
}

function suggestsOAuthFlow(message: string): boolean {
  return /please authenticate|-32001/i.test(message);
}

function isAuthError(message: string): boolean {
  return (
    /\b401\b/.test(message) ||
    /authorization/i.test(message) ||
    /missing.*header/i.test(message) ||
    /unauthorized/i.test(message) ||
    /authentication required/i.test(message) ||
    /please authenticate/i.test(message) ||
    message.includes("-32001")
  );
}

function isNetworkError(message: string): boolean {
  return (
    /connection refused/i.test(message) ||
    /econnrefused/i.test(message) ||
    /etimedout/i.test(message) ||
    /\btimeout\b/i.test(message) ||
    /enotfound/i.test(message) ||
    /network/i.test(message) ||
    /fetch failed/i.test(message)
  );
}

/** Shorten long error strings for list/detail display. */
export function shortMcpError(message: string, maxLen = 80): string {
  const oneLine = message.split("\n")[0]?.trim() ?? message;
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 1)}…`;
}

function oauthAuthHint(serverName?: string): string {
  return serverName ? mcpOAuthAuthHint(serverName) : "Authenticate via OAuth (/mcp → Authenticate).";
}

function bearerAuthHint(config: McpServerConfig): string {
  return hasMcpAuth(config)
    ? "Check that your Bearer token is valid."
    : "Add a Bearer token: /mcp → edit this server (stored as Authorization header).";
}

export function classifyMcpFailure(
  error: unknown,
  config: McpServerConfig,
  serverName?: string,
): McpFailureInfo {
  const message = error instanceof Error ? error.message : String(error);
  const reason = shortMcpError(message);

  if (message === "Unauthorized" && isMcpOAuthConfigured(config)) {
    return { status: "needs_auth", reason: "OAuth authentication required", hint: oauthAuthHint(serverName) };
  }

  if (isAuthError(message)) {
    if (isMcpOAuthConfigured(config)) {
      return { status: "needs_auth", reason, hint: oauthAuthHint(serverName) };
    }
    if (suggestsOAuthFlow(message)) {
      return { status: "needs_auth", reason, hint: mcpOAuthSetupHint(serverName) };
    }
    return { status: "needs_auth", reason, hint: bearerAuthHint(config) };
  }

  if (isNetworkError(message)) {
    return {
      status: "failed",
      reason,
      hint: "Check that the server is running and the URL is correct.",
    };
  }

  if (config.type === "stdio") {
    if (/could not determine executable/i.test(message)) {
      return {
        status: "failed",
        reason,
        hint: `Check stdio args for "${config.command}" — e.g. npx -y @modelcontextprotocol/server-filesystem .`,
      };
    }
    if (/connection closed/i.test(message)) {
      return {
        status: "failed",
        reason,
        hint: `Stdio server "${config.command}" exited — check command and args in /mcp → edit.`,
      };
    }
  }

  return { status: "failed", reason };
}

export function mcpListStatusLabel(status: McpConnectionStatus, toolCount: number): string {
  switch (status) {
    case "connected":
      return `${toolCount} tools`;
    case "needs_auth":
      return "needs auth";
    case "disabled":
      return "disabled";
    case "failed":
      return "failed";
  }
}

export function mcpSummaryPart(name: string, status: McpConnectionStatus, toolCount: number): string {
  switch (status) {
    case "connected":
      return `${name} (${toolCount} tools)`;
    case "needs_auth":
      return `${name} needs auth`;
    case "disabled":
      return `${name} disabled`;
    case "failed":
      return `${name} failed`;
  }
}
