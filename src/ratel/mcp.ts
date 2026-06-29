import { z } from "zod";
import type { ToolCatalog } from "@ratel-ai/sdk";
import type { McpServerHandle } from "./register-mcp.js";
import { registerMcpServer } from "./register-mcp.js";
import type { AnyTool } from "../tools/registry.js";
import { renderMcpContent } from "../mcp/adapter.js";
import { makeTransport } from "../mcp/client.js";
import { loadMcpConfig, type McpServerConfig } from "../mcp/config.js";
import {
  classifyMcpFailure,
  mcpSummaryPart,
  type McpConnectionStatus,
} from "../mcp/status.js";
import type { McpServerStatus } from "../mcp/loader.js";

export interface RatelMcpLoadResult {
  /** Orin wrappers for approval + hook-aware execution (ids: `server__tool`). */
  tools: AnyTool[];
  handles: McpServerHandle[];
  dispose: () => Promise<void>;
  warnings: string[];
  servers: McpServerStatus[];
  statusHint?: string;
}

function isDisabled(config: McpServerConfig): boolean {
  return config.disabled === true;
}

/** Wrap a catalog MCP tool for Orin's approval gate and output rendering. */
export function wrapCatalogMcpTool(catalog: ToolCatalog, toolId: string): AnyTool {
  const meta = catalog.get(toolId);
  return {
    name: toolId,
    description: meta?.description ?? "",
    schema: z.record(z.string(), z.unknown()),
    needsApproval: () => true,
    async execute(args, _ctx, _signal) {
      const result = await catalog.invoke(toolId, args as Record<string, unknown>);
      return { output: formatMcpInvokeOutput(result) };
    },
  };
}

function formatMcpInvokeOutput(value: unknown): string {
  if (typeof value === "object" && value !== null && "content" in value) {
    return renderMcpContent((value as { content: unknown }).content);
  }
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/**
 * Ingest MCP upstreams into a Ratel ToolCatalog via `registerMcpServer` (Mode 3
 * hybrid — integration-patterns.md). One connection per server; no parallel flat list.
 */
export async function loadMcpIntoRatelCatalog(
  catalog: ToolCatalog,
): Promise<RatelMcpLoadResult> {
  const { config, warnings } = loadMcpConfig();
  const entries = Object.entries(config.servers);

  if (entries.length === 0) {
    return { tools: [], handles: [], servers: [], warnings, dispose: async () => {} };
  }

  const activeEntries: [string, McpServerConfig][] = [];
  const servers: McpServerStatus[] = [];
  const summaryParts: string[] = [];

  for (const [serverName, serverConfig] of entries) {
    if (isDisabled(serverConfig)) {
      summaryParts.push(mcpSummaryPart(serverName, "disabled", 0));
      servers.push({
        name: serverName,
        config: serverConfig,
        status: "disabled",
        toolCount: 0,
      });
      continue;
    }
    activeEntries.push([serverName, serverConfig]);
  }

  const handles: McpServerHandle[] = [];
  const tools: AnyTool[] = [];

  for (const [serverName, serverConfig] of activeEntries) {
    try {
      const handle = await registerMcpServer(catalog, {
        name: serverName,
        transport: makeTransport(serverName, serverConfig),
      });
      handles.push(handle);
      for (const toolId of handle.toolIds) {
        tools.push(wrapCatalogMcpTool(catalog, toolId));
      }
      summaryParts.push(mcpSummaryPart(serverName, "connected", handle.toolIds.length));
      servers.push({
        name: serverName,
        config: serverConfig,
        status: "connected",
        toolCount: handle.toolIds.length,
      });
    } catch (err) {
      const failure = classifyMcpFailure(err, serverConfig, serverName);
      const message = failure.reason;
      warnings.push(`MCP server "${serverName}" failed to connect: ${message}`);
      summaryParts.push(mcpSummaryPart(serverName, failure.status, 0));
      servers.push({
        name: serverName,
        config: serverConfig,
        status: failure.status,
        toolCount: 0,
        error: failure.reason,
        hint: failure.hint,
      });
    }
  }

  const statusHint = summaryParts.length > 0 ? `MCP: ${summaryParts.join(" · ")}` : undefined;

  return {
    tools,
    handles,
    servers,
    warnings,
    statusHint,
    dispose: async () => {
      await Promise.allSettled(handles.map((h) => h.close()));
    },
  };
}

export type { McpConnectionStatus };
