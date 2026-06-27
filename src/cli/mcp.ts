import { authenticateMcpServer } from "../mcp/oauth.js";
import { flagValue } from "../cli-args.js";

export async function runMcpCli(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "auth") {
    const serverName = args[1];
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
    return;
  }

  console.error("Usage: orin mcp auth <server> [--code <authorization-code>]");
  process.exit(1);
}
