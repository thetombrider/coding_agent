import type { McpServerStatus } from "../mcp/loader.js";
import { isMcpOAuthConfigured, mcpOAuthAuthHint } from "../mcp/oauth-config.js";
import { mcpDetailCanAuthenticate } from "../mcp/oauth.js";
import { mcpListStatusLabel } from "../mcp/status.js";
import { formatServerConfigSummary, mcpAuthModeLabel } from "../mcp/wizard.js";

export const MCP_ADD_ACTION = "__mcp_add__";
export const MCP_RELOAD_ACTION = "__mcp_reload__";

export type McpPaletteMenu = "list" | "detail" | "delete";

export type McpPaletteState = {
  phase: "mcp";
  menu: McpPaletteMenu;
  index: number;
  servers: McpServerStatus[];
  /** Server name when menu is detail or delete. */
  selectedName?: string;
};

export type McpListRow =
  | { kind: "server"; server: McpServerStatus }
  | { kind: "add" }
  | { kind: "reload" };

export function mcpListRows(servers: McpServerStatus[]): McpListRow[] {
  return [
    ...servers.map((server) => ({ kind: "server" as const, server })),
    { kind: "add" },
    { kind: "reload" },
  ];
}

export function mcpListRowLabel(row: McpListRow): string {
  if (row.kind === "add") return "+ Add server";
  if (row.kind === "reload") return "↻ Reload connections";
  const s = row.server;
  const status = mcpListStatusLabel(s.status, s.toolCount);
  return `${s.name}  ·  ${formatServerConfigSummary(s.config)}  ·  ${status}  ·  ${s.scope}`;
}

export function selectedMcpListRow(state: McpPaletteState): McpListRow | undefined {
  return mcpListRows(state.servers)[state.index];
}

export function selectedMcpServer(state: McpPaletteState): McpServerStatus | undefined {
  const row = selectedMcpListRow(state);
  return row?.kind === "server" ? row.server : undefined;
}

export function mcpPaletteHint(menu: McpPaletteMenu, server?: McpServerStatus): string {
  switch (menu) {
    case "list":
      return "↑↓ navigate · Enter select · Esc back";
    case "detail":
      if (server && mcpDetailCanAuthenticate(server)) {
        return "a authenticate · d enable/disable · Enter edit · → delete · ← or Esc back";
      }
      return "d enable/disable · Enter edit · → delete · ← or Esc back";
    case "delete":
      return "Enter confirm delete · ← or Esc cancel";
  }
}

export function mcpServerSupportsOAuth(server: McpServerStatus): boolean {
  return mcpDetailCanAuthenticate(server);
}

export function mcpServerDetailLines(server: McpServerStatus): string[] {
  const lines = [
    `name: ${server.name}`,
    `scope: ${server.scope}`,
    `transport: ${server.config.type}`,
    `config: ${formatServerConfigSummary(server.config)}`,
  ];
  if (server.config.type === "http" || server.config.type === "ws") {
    lines.push(`auth: ${mcpAuthModeLabel(server.config)}`);
  }
  if (server.config.autoApprove && server.config.autoApprove.length > 0) {
    lines.push(`autoApprove: ${server.config.autoApprove.join(", ")}`);
  }

  switch (server.status) {
    case "connected":
      lines.push(`status: connected (${server.toolCount} tools)`);
      break;
    case "disabled":
      lines.push("status: disabled");
      break;
    case "needs_auth":
      lines.push("status: needs auth");
      if (server.error) lines.push(`reason: ${server.error}`);
      if (server.hint) lines.push(`hint: ${server.hint}`);
      else if (isMcpOAuthConfigured(server.config)) {
        lines.push(`hint: ${mcpOAuthAuthHint(server.name)}`);
      }
      break;
    case "failed":
      lines.push(`status: failed${server.error ? ` — ${server.error}` : ""}`);
      if (server.hint) lines.push(`hint: ${server.hint}`);
      break;
  }

  return lines;
}

export function mcpPaletteAfterReload(
  servers: McpServerStatus[],
  previous: McpPaletteState,
): McpPaletteState {
  const rows = mcpListRows(servers);
  const clamped = Math.min(previous.index, Math.max(0, rows.length - 1));
  if (previous.menu === "detail" || previous.menu === "delete") {
    const stillExists = servers.some((s) => s.name === previous.selectedName);
    if (!stillExists) {
      return { phase: "mcp", menu: "list", index: clamped, servers };
    }
    return { ...previous, servers, selectedName: previous.selectedName };
  }
  return { ...previous, servers, index: clamped };
}
