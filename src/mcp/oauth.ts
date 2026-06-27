import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpHttpConfig, McpServerConfig } from "./config.js";
import { connectServer, type ConnectedMcpServer } from "./client.js";
import { loadMcpConfig, upsertMcpServer } from "./config.js";
import { isMcpOAuthConfigured, type McpOAuthOptions } from "./oauth-config.js";
import { startOAuthCallbackServer } from "./oauth-callback.js";
import { createOrinMcpOAuthProvider } from "./oauth-provider.js";

export interface AuthenticateMcpServerOptions {
  /** Authorization code from redirect (for `orin mcp auth <name> --code …`). */
  authorizationCode?: string;
  /** Open browser when the server returns a redirect. Default true unless code is provided. */
  openBrowser?: boolean;
  /** Max ms to wait for browser callback. Default 5 minutes. */
  timeoutMs?: number;
}

export interface AuthenticateMcpServerResult {
  ok: boolean;
  toolCount?: number;
  error?: string;
}

function assertHttpOAuthServer(
  name: string,
  config: McpServerConfig | undefined,
): asserts config is McpHttpConfig {
  if (!config) throw new Error(`MCP server "${name}" not found`);
  if (config.type !== "http") {
    throw new Error(`MCP server "${name}" uses ${config.type} transport — OAuth applies to http servers only`);
  }
  if (!isMcpOAuthConfigured(config)) {
    throw new Error(`MCP server "${name}" is not configured for OAuth — enable oauth in /mcp → edit first`);
  }
}

function httpTransportOptions(config: McpHttpConfig) {
  const opts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {};
  if (config.headers && Object.keys(config.headers).length > 0) {
    opts.requestInit = { headers: config.headers };
  }
  return opts;
}

async function connectWithOAuthTransport(
  name: string,
  config: McpHttpConfig,
  redirectUrl: string | URL,
  openBrowser: boolean,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport; tools: ConnectedMcpServer["tools"] }> {
  const provider = createOrinMcpOAuthProvider({
    serverName: name,
    config,
    redirectUrl,
    openBrowser,
  });
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    ...httpTransportOptions(config),
    authProvider: provider,
  });
  const client = new Client({ name: "orin", version: "0.1.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  return { client, transport, tools };
}

/** Run browser-based OAuth for an MCP server and verify tool listing works. */
export async function authenticateMcpServer(
  serverName: string,
  opts: AuthenticateMcpServerOptions = {},
): Promise<AuthenticateMcpServerResult> {
  const { config } = loadMcpConfig();
  const serverConfig = config.servers[serverName];
  assertHttpOAuthServer(serverName, serverConfig);

  const openBrowser = opts.openBrowser ?? opts.authorizationCode === undefined;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  let callbackServer: Awaited<ReturnType<typeof startOAuthCallbackServer>> | undefined;

  try {
    if (opts.authorizationCode) {
      const redirectUrl = new URL("http://127.0.0.1/callback");
      const provider = createOrinMcpOAuthProvider({
        serverName,
        config: serverConfig,
        redirectUrl,
        openBrowser: false,
      });
      const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
        ...httpTransportOptions(serverConfig),
        authProvider: provider,
      });
      await transport.finishAuth(opts.authorizationCode);
      await transport.close();
      const connected = await connectServer(serverName, serverConfig);
      await connected.client.close();
      return { ok: true, toolCount: connected.tools.length };
    }

    callbackServer = await startOAuthCallbackServer();
    const redirectUrl = callbackServer.redirectUrl;

    try {
      const connected = await connectWithOAuthTransport(
        serverName,
        serverConfig,
        redirectUrl,
        openBrowser,
      );
      await connected.client.close();
      return { ok: true, toolCount: connected.tools.length };
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
    }

    const codePromise = callbackServer.waitForCode;
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("OAuth timed out waiting for browser callback")), timeoutMs);
    });

    let authCode: string;
    try {
      ({ code: authCode } = await Promise.race([codePromise, timeout]));
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const provider = createOrinMcpOAuthProvider({
      serverName,
      config: serverConfig,
      redirectUrl,
      openBrowser: false,
    });
    const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
      ...httpTransportOptions(serverConfig),
      authProvider: provider,
    });
    await transport.finishAuth(authCode);
    await transport.close();

    const connected = await connectServer(serverName, serverConfig);
    await connected.client.close();
    return { ok: true, toolCount: connected.tools.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    callbackServer?.close();
  }
}

export function serverNeedsOAuthAuthenticate(
  config: McpServerConfig,
  status: "connected" | "needs_auth" | "failed" | "disabled",
): boolean {
  return status === "needs_auth" && isMcpOAuthConfigured(config);
}

/** HTTP server failed auth and can be fixed via OAuth from the TUI (configured or OAuth-style error). */
export function mcpDetailCanAuthenticate(server: {
  name: string;
  config: McpServerConfig;
  status: "connected" | "needs_auth" | "failed" | "disabled";
  error?: string;
}): boolean {
  if (server.config.type !== "http" || server.status !== "needs_auth") return false;
  if (isMcpOAuthConfigured(server.config)) return true;
  const message = server.error ?? "";
  return /please authenticate|-32001|authentication required/i.test(message);
}

export async function enableMcpOAuth(
  serverName: string,
  oauth: true | McpOAuthOptions = {},
): Promise<void> {
  const { config } = loadMcpConfig();
  const server = config.servers[serverName];
  if (!server) throw new Error(`MCP server "${serverName}" not found`);
  if (server.type !== "http") {
    throw new Error(`MCP server "${serverName}" is not an HTTP server`);
  }
  upsertMcpServer(serverName, { ...server, oauth } satisfies McpHttpConfig);
}
