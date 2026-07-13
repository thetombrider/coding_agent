import { z } from "zod";
import type { ToolCatalog } from "@ratel-ai/sdk";
import type { McpServerHandle } from "./register-mcp.js";
import { registerMcpServer } from "./register-mcp.js";
import type { AnyTool } from "../tools/registry.js";
import { buildMcpProviderSchema, schemaFromProviderInput } from "../tools/provider-schema.js";
import { renderMcpContent } from "../mcp/adapter.js";
import { makeTransport } from "../mcp/client.js";
import { loadMcpConfig, type McpScope, type McpServerConfig } from "../mcp/config.js";
import { MCP_TOOL_SEP } from "../mcp/names.js";
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
export function wrapCatalogMcpTool(catalog: ToolCatalog, toolId: string, autoApproved = false): AnyTool {
  const meta = catalog.get(toolId);
  const rawInputSchema =
    meta?.inputSchema && typeof meta.inputSchema === "object"
      ? (meta.inputSchema as Record<string, unknown>)
      : undefined;
  const provider = buildMcpProviderSchema(toolId, rawInputSchema);
  return {
    name: toolId,
    description: meta?.description ?? "",
    schema: rawInputSchema ? schemaFromProviderInput(rawInputSchema) : z.record(z.string(), z.unknown()),
    ...provider,
    needsApproval: autoApproved ? () => false : () => true,
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
  projectCwd?: string,
): Promise<RatelMcpLoadResult> {
  const { config, scopes, warnings } = loadMcpConfig(projectCwd);
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
        scope: (scopes[serverName] ?? "global") as McpScope,
      });
      continue;
    }
    activeEntries.push([serverName, serverConfig]);
  }

  const handles: McpServerHandle[] = [];
  const tools: AnyTool[] = [];

  const results = await Promise.allSettled(
    activeEntries.map(([serverName, serverConfig]) =>
      registerMcpServer(catalog, {
        name: serverName,
        transport: makeTransport(serverName, serverConfig),
      }).then((handle: McpServerHandle) => ({ serverName, serverConfig, handle })),
    ),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    const [serverName, serverConfig] = activeEntries[i]!;
    if (result.status === "fulfilled") {
      const { handle } = result.value;
      handles.push(handle);
      const autoApproveIds = serverConfig.autoApprove?.length
        ? new Set(serverConfig.autoApprove.map((t) => `${serverName}${MCP_TOOL_SEP}${t}`))
        : undefined;
      for (const toolId of handle.toolIds) {
        tools.push(wrapCatalogMcpTool(catalog, toolId, autoApproveIds?.has(toolId) ?? false));
      }
      summaryParts.push(mcpSummaryPart(serverName, "connected", handle.toolIds.length));
      servers.push({
        name: serverName,
        config: serverConfig,
        status: "connected",
        toolCount: handle.toolIds.length,
        scope: (scopes[serverName] ?? "global") as McpScope,
      });
    } else {
      const failure = classifyMcpFailure(result.reason, serverConfig, serverName);
      warnings.push(`MCP server "${serverName}" failed to connect: ${failure.reason}`);
      summaryParts.push(mcpSummaryPart(serverName, failure.status, 0));
      servers.push({
        name: serverName,
        config: serverConfig,
        status: failure.status,
        toolCount: 0,
        error: failure.reason,
        hint: failure.hint,
        scope: (scopes[serverName] ?? "global") as McpScope,
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
