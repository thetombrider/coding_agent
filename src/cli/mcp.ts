import { connectServer, type ConnectedMcpServer, type RemoteTool } from "../mcp/client.js";
import { loadMcpConfig, type McpScope, type McpServerConfig } from "../mcp/config.js";
import { loadMcpServers } from "../mcp/loader.js";
import { authenticateMcpServer } from "../mcp/oauth.js";
import { classifyMcpFailure, mcpListStatusLabel, type McpConnectionStatus } from "../mcp/status.js";
import { formatServerConfigSummary } from "../mcp/wizard.js";
import { flagValue } from "../cli-args.js";

const USAGE = "Usage: orin mcp <list [--live] | auth <server> [--code <code>] | debug <server>>";

interface McpListItem {
  name: string;
  config: McpServerConfig;
  scope: McpScope;
  status: McpConnectionStatus | "configured";
  toolCount: number;
  error?: string;
  hint?: string;
}

function statusCell(item: McpListItem): string {
  if (item.status === "configured") return "configured";
  return mcpListStatusLabel(item.status, item.toolCount);
}

function formatMcpListTable(items: McpListItem[]): string[] {
  const headers = ["NAME", "SCOPE", "STATUS", "CONFIG"];
  const rows = items.map((item) => [
    item.name,
    item.scope,
    statusCell(item),
    formatServerConfigSummary(item.config),
  ]);

  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i].length))
  );

  return [headers, ...rows].map((row) =>
    row.map((cell, i) => cell.padEnd(widths[i])).join("  ")
  );
}

function printMcpList(items: McpListItem[]): void {
  if (items.length === 0) {
    console.log("No MCP servers configured.");
    return;
  }
  for (const line of formatMcpListTable(items)) {
    console.log(line);
  }
}

async function runMcpList(args: string[]): Promise<void> {
  const live = args.includes("--live");
  const cwd = process.cwd();

  if (live) {
    const { servers, warnings, dispose } = await loadMcpServers(cwd);
    for (const warning of warnings) console.warn(warning);
    printMcpList(servers);
    await dispose();
    return;
  }

  const { config, scopes, warnings } = loadMcpConfig(cwd);
  for (const warning of warnings) console.warn(warning);

  const items: McpListItem[] = Object.entries(config.servers).map(([name, serverConfig]) => ({
    name,
    config: serverConfig,
    scope: scopes[name] ?? "global",
    status: serverConfig.disabled === true ? "disabled" : "configured",
    toolCount: 0,
  }));

  printMcpList(items);
}

async function runMcpDebug(args: string[]): Promise<void> {
  const serverName = args[0];
  if (!serverName || serverName.startsWith("-")) {
    console.error("Usage: orin mcp debug <server>");
    process.exit(1);
  }

  const { config } = loadMcpConfig(process.cwd());
  const serverConfig = config.servers[serverName];
  if (!serverConfig) {
    console.error(`MCP server "${serverName}" not found.`);
    process.exit(1);
  }

  let result: ConnectedMcpServer | undefined;
  try {
    result = await connectServer(serverName, serverConfig);
    const { tools } = result;
    if (tools.length === 0) {
      console.log(`Connected to "${serverName}" — no tools advertised.`);
    } else {
      console.log(`Connected to "${serverName}" — ${tools.length} tool${tools.length === 1 ? "" : "s"}:`);
      for (const tool of tools as RemoteTool[]) {
        const line = tool.description ? `${tool.name}: ${tool.description}` : tool.name;
        console.log(`  ${line}`);
      }
    }
  } catch (err) {
    const failure = classifyMcpFailure(err, serverConfig, serverName);
    console.error(`Connection failed: ${failure.reason}`);
    if (failure.hint) console.error(`Hint: ${failure.hint}`);
    process.exit(1);
  } finally {
    await result?.client.close().catch(() => {});
  }
}

async function runMcpAuth(args: string[]): Promise<void> {
  const serverName = args[0];
  if (!serverName || serverName.startsWith("-")) {
    console.error("Usage: orin mcp auth <server> [--code <authorization-code>]");
    process.exit(1);
  }
  const code = flagValue(args, "--code");
  console.log(`Authenticating MCP server "${serverName}"…`);
  const result = await authenticateMcpServer(serverName, {
    authorizationCode: code,
    openBrowser: !code,
  });
  if (!result.ok) {
    console.error(`Authentication failed: ${result.error ?? "unknown error"}`);
    process.exit(1);
  }
  console.log(`Authenticated — ${result.toolCount ?? 0} tools available.`);
}

export async function runMcpCli(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "list") {
    await runMcpList(args.slice(1));
    return;
  }
  if (sub === "debug") {
    await runMcpDebug(args.slice(1));
    return;
  }
  if (sub === "auth") {
    await runMcpAuth(args.slice(1));
    return;
  }

  console.error(USAGE);
  process.exit(1);
}
