import type { McpServerStatus } from "../mcp/loader.js";
import { formatServerConfigSummary } from "../mcp/wizard.js";

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
  const status = s.connected ? `${s.toolCount} tools` : "failed";
  return `${s.name}  ·  ${formatServerConfigSummary(s.config)}  ·  ${status}`;
}

export function selectedMcpListRow(state: McpPaletteState): McpListRow | undefined {
  return mcpListRows(state.servers)[state.index];
}

export function selectedMcpServer(state: McpPaletteState): McpServerStatus | undefined {
  const row = selectedMcpListRow(state);
  return row?.kind === "server" ? row.server : undefined;
}

export function mcpPaletteHint(menu: McpPaletteMenu): string {
  switch (menu) {
    case "list":
      return "↑↓ navigate · Enter select · Esc back";
    case "detail":
      return "Enter edit · → delete · ← or Esc back";
    case "delete":
      return "Enter confirm delete · ← or Esc cancel";
  }
}

export function mcpServerDetailLines(server: McpServerStatus): string[] {
  const lines = [
    `name: ${server.name}`,
    `transport: ${server.config.type}`,
    `config: ${formatServerConfigSummary(server.config)}`,
    server.connected
      ? `status: connected (${server.toolCount} tools)`
      : `status: failed — ${server.error ?? "connection error"}`,
  ];
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
