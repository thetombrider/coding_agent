import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AnyTool } from "../tools/registry.js";
import { toLocalTool } from "./adapter.js";
import { connectServer } from "./client.js";
import { loadMcpConfig, type McpScope, type McpServerConfig } from "./config.js";
import { MCP_TOOL_SEP } from "./names.js";
import {
  classifyMcpFailure,
  mcpSummaryPart,
  type McpConnectionStatus,
} from "./status.js";

export interface McpServerStatus {
  name: string;
  config: McpServerConfig;
  status: McpConnectionStatus;
  toolCount: number;
  error?: string;
  hint?: string;
  scope: McpScope;
}

export interface McpLoadResult {
  tools: AnyTool[];
  dispose: () => Promise<void>;
  warnings: string[];
  servers: McpServerStatus[];
  /** e.g. `MCP: fs (8 tools) · github needs auth` */
  statusHint?: string;
}

function isDisabled(config: McpServerConfig): boolean {
  return config.disabled === true;
}

export async function loadMcpServers(projectCwd?: string): Promise<McpLoadResult> {
  const { config, scopes, warnings } = loadMcpConfig(projectCwd);
  const entries = Object.entries(config.servers);

  if (entries.length === 0) {
    return { tools: [], servers: [], warnings, dispose: async () => {} };
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
        scope: scopes[serverName] ?? "global",
      });
      continue;
    }
    activeEntries.push([serverName, serverConfig]);
  }

  const results = await Promise.allSettled(
    activeEntries.map(([name, serverConfig]) => connectServer(name, serverConfig)),
  );

  const clients: Client[] = [];
  const tools: AnyTool[] = [];

  for (let i = 0; i < results.length; i++) {
    const [serverName, serverConfig] = activeEntries[i]!;
    const result = results[i]!;

    if (result.status === "fulfilled") {
      const { client, tools: remoteTools, name } = result.value;
      clients.push(client);
      const [, serverConfig] = activeEntries[i]!;
      const autoApproveIds = serverConfig.autoApprove?.length
        ? new Set(serverConfig.autoApprove.map((t) => `${name}${MCP_TOOL_SEP}${t}`))
        : undefined;
      tools.push(...remoteTools.map((t) => toLocalTool(client, name, t, autoApproveIds)));
      summaryParts.push(mcpSummaryPart(name, "connected", remoteTools.length));
      servers.push({
        name,
        config: serverConfig,
        status: "connected",
        toolCount: remoteTools.length,
        scope: scopes[serverName] ?? "global",
      });
    } else {
      const failure = classifyMcpFailure(result.reason, serverConfig, serverName);
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
        scope: scopes[serverName] ?? "global",
      });
    }
  }

  const statusHint = summaryParts.length > 0 ? `MCP: ${summaryParts.join(" · ")}` : undefined;

  return {
    tools,
    servers,
    warnings,
    statusHint,
    dispose: async () => {
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };
}
