/** Separator between MCP server name and remote tool name in the local registry. */
export const MCP_TOOL_SEP = "__";

export function isMcpTool(name: string): boolean {
  return name.includes(MCP_TOOL_SEP);
}

/** Display label: `fs__read_file` → `fs · read_file`. */
export function formatMcpToolLabel(name: string): string {
  const idx = name.indexOf(MCP_TOOL_SEP);
  if (idx === -1) return name;
  return `${name.slice(0, idx)} · ${name.slice(idx + MCP_TOOL_SEP.length)}`;
}
