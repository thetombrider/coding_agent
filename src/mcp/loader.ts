import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AnyTool } from "../tools/registry.js";
import { toLocalTool } from "./adapter.js";
import { connectServer } from "./client.js";
import { loadMcpConfig, type McpServerConfig } from "./config.js";

export interface McpServerStatus {
  name: string;
  config: McpServerConfig;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export interface McpLoadResult {
  tools: AnyTool[];
  dispose: () => Promise<void>;
  warnings: string[];
  servers: McpServerStatus[];
  /** e.g. `MCP: fs (8 tools) · github failed` */
  statusHint?: string;
}

function formatFailureReason(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export async function loadMcpServers(): Promise<McpLoadResult> {
  const { config, warnings } = loadMcpConfig();
  const entries = Object.entries(config.servers);

  if (entries.length === 0) {
    return { tools: [], servers: [], warnings, dispose: async () => {} };
  }

  const results = await Promise.allSettled(
    entries.map(([name, serverConfig]) => connectServer(name, serverConfig)),
  );

  const clients: Client[] = [];
  const tools: AnyTool[] = [];
  const servers: McpServerStatus[] = [];
  const summaryParts: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const [serverName, serverConfig] = entries[i]!;
    const result = results[i]!;

    if (result.status === "fulfilled") {
      const { client, tools: remoteTools, name } = result.value;
      clients.push(client);
      tools.push(...remoteTools.map((t) => toLocalTool(client, name, t)));
      summaryParts.push(`${name} (${remoteTools.length} tools)`);
      servers.push({
        name,
        config: serverConfig,
        connected: true,
        toolCount: remoteTools.length,
      });
    } else {
      const message = formatFailureReason(result.reason);
      warnings.push(`MCP server "${serverName}" failed to connect: ${message}`);
      console.warn(`MCP server failed to connect (${serverName}): ${message}`);
      summaryParts.push(`${serverName} failed`);
      servers.push({
        name: serverName,
        config: serverConfig,
        connected: false,
        toolCount: 0,
        error: message,
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
