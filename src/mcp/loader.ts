import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AnyTool } from "../tools/registry.js";
import { toLocalTool } from "./adapter.js";
import { connectServer } from "./client.js";
import { loadMcpConfig, type McpServerConfig } from "./config.js";
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

export async function loadMcpServers(): Promise<McpLoadResult> {
  const { config, warnings } = loadMcpConfig();
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
      tools.push(...remoteTools.map((t) => toLocalTool(client, name, t)));
      summaryParts.push(mcpSummaryPart(name, "connected", remoteTools.length));
      servers.push({
        name,
        config: serverConfig,
        status: "connected",
        toolCount: remoteTools.length,
      });
    } else {
      const failure = classifyMcpFailure(result.reason, serverConfig, serverName);
      const message = failure.reason;
      warnings.push(`MCP server "${serverName}" failed to connect: ${message}`);
      console.warn(`MCP server failed to connect (${serverName}): ${message}`);
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
    servers,
    warnings,
    statusHint,
    dispose: async () => {
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };
}
