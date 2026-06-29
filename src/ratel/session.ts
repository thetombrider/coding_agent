import type { AnyTool } from "../tools/registry.js";
import { getCoreTools } from "../tools/registry.js";
import { loadMcpServers, type McpLoadResult } from "../mcp/loader.js";
import { isRatelEnabled } from "./config.js";
import { OrinRatelBundle } from "./catalog.js";

export interface OrinToolingBootstrap {
  tools: AnyTool[];
  ratel?: OrinRatelBundle;
  mcpTools: AnyTool[];
  mcpDispose: () => Promise<void>;
  mcpServers: McpLoadResult["servers"];
  mcpWarnings: string[];
  mcpStatusHint?: string;
}

/** Load flat MCP or Ratel hybrid session (registerMcpServer when enabled). */
export async function bootstrapOrinTooling(
  cwd: string,
  sessionId?: string,
): Promise<OrinToolingBootstrap> {
  if (isRatelEnabled()) {
    const session = await OrinRatelBundle.create(cwd, { sessionId });
    return {
      tools: session.tools,
      ratel: session.bundle,
      mcpTools: [],
      mcpDispose: session.mcpDispose,
      mcpServers: session.mcpServers,
      mcpWarnings: session.mcpWarnings,
      mcpStatusHint: session.mcpStatusHint,
    };
  }

  const mcp = await loadMcpServers();
  return {
    tools: [...getCoreTools(), ...mcp.tools],
    mcpTools: mcp.tools,
    mcpDispose: mcp.dispose,
    mcpServers: mcp.servers,
    mcpWarnings: mcp.warnings,
    mcpStatusHint: mcp.statusHint,
  };
}

/** Rebuild tooling after MCP config change. */
export async function reloadOrinTooling(
  cwd: string,
  sessionId?: string,
): Promise<OrinToolingBootstrap> {
  return bootstrapOrinTooling(cwd, sessionId);
}

/** Tools passed to runLoop — full execution registry, Ratel-aware. */
export function loopTools(
  flatTools: AnyTool[],
  ratel: OrinRatelBundle | undefined,
): AnyTool[] {
  return ratel ? ratel.executionTools() : flatTools;
}

/** Child subagent Ratel bundle — filtered tool preset, no MCP upstreams. */
export function buildChildRatelBundle(childTools: AnyTool[], cwd: string): OrinRatelBundle | undefined {
  if (!isRatelEnabled()) return undefined;
  return OrinRatelBundle.buildForChild(childTools, cwd);
}
