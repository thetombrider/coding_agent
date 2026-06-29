import type { AnyTool } from "../tools/registry.js";
import { getCoreTools } from "../tools/registry.js";

/** Replaced by Ratel gateway tools when `ratel.enabled` is on. */
const RATEL_GATEWAY_REPLACEMENTS = new Set(["skill_list", "skill_use"]);

/** Core native tools registered into the Ratel catalog (MCP ingested separately). */
export function coreToolsForRatel(): AnyTool[] {
  return getCoreTools().filter((t) => !RATEL_GATEWAY_REPLACEMENTS.has(t.name));
}

export function filterToolsForRatelCatalog(tools: AnyTool[]): AnyTool[] {
  return tools.filter((t) => !RATEL_GATEWAY_REPLACEMENTS.has(t.name));
}
