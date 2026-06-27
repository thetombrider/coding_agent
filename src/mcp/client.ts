import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpHttpConfig, McpServerConfig } from "./config.js";
import { isMcpOAuthConfigured } from "./oauth-config.js";
import { createOrinMcpOAuthProvider } from "./oauth-provider.js";
import { hasMcpOAuthSession } from "./oauth-store.js";

export type RemoteTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

function httpTransportOptions(name: string, config: McpHttpConfig) {
  const opts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {};
  if (config.headers && Object.keys(config.headers).length > 0) {
    opts.requestInit = { headers: config.headers };
  }
  if (isMcpOAuthConfigured(config) && hasMcpOAuthSession(name)) {
    opts.authProvider = createOrinMcpOAuthProvider({
      serverName: name,
      config,
      redirectUrl: "http://127.0.0.1/callback",
      openBrowser: false,
    });
  }
  return Object.keys(opts).length > 0 ? opts : undefined;
}

export function makeTransport(name: string, config: McpServerConfig): Transport {
  switch (config.type) {
    case "stdio":
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
      });
    case "http":
      return new StreamableHTTPClientTransport(
        new URL(config.url),
        httpTransportOptions(name, config),
      );
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
  await client.connect(makeTransport(name, config));
  const { tools } = await client.listTools();
  return { client, tools, name };
}
