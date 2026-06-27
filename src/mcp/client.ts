import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "./config.js";

export type RemoteTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

export function makeTransport(config: McpServerConfig): Transport {
  switch (config.type) {
    case "stdio":
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
      });
    case "http":
      return new StreamableHTTPClientTransport(new URL(config.url));
    case "ws":
      return new WebSocketClientTransport(new URL(config.url));
  }
}

export interface ConnectedMcpServer {
  client: Client;
  tools: RemoteTool[];
  name: string;
}

export async function connectServer(name: string, config: McpServerConfig): Promise<ConnectedMcpServer> {
  const client = new Client({ name: "orin", version: "0.1.0" });
  await client.connect(makeTransport(config));
  const { tools } = await client.listTools();
  return { client, tools, name };
}
