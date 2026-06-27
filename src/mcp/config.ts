import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type McpStdioConfig = {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type McpHttpConfig = {
  type: "http";
  url: string;
};

export type McpWsConfig = {
  type: "ws";
  url: string;
};

export type McpServerConfig = McpStdioConfig | McpHttpConfig | McpWsConfig;

export type McpTransportType = McpServerConfig["type"];

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

const EMPTY: McpConfig = { servers: {} };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseServerEntry(name: string, raw: unknown): { config?: McpServerConfig; warning?: string } {
  if (!isRecord(raw)) {
    return { warning: `MCP server "${name}": expected an object, skipping.` };
  }

  const type = raw.type;
  if (type === "stdio") {
    if (typeof raw.command !== "string" || !raw.command.trim()) {
      return { warning: `MCP server "${name}": stdio transport requires a non-empty "command", skipping.` };
    }
    const env =
      raw.env === undefined
        ? undefined
        : isRecord(raw.env) &&
            Object.entries(raw.env).every(([k, v]) => typeof k === "string" && typeof v === "string")
          ? (raw.env as Record<string, string>)
          : undefined;
    if (raw.env !== undefined && env === undefined) {
      return { warning: `MCP server "${name}": "env" must be a string map, skipping.` };
    }
    const args = Array.isArray(raw.args)
      ? raw.args.filter((a): a is string => typeof a === "string")
      : undefined;
    const cwd = typeof raw.cwd === "string" ? raw.cwd : undefined;
    return {
      config: {
        type: "stdio",
        command: raw.command,
        args,
        env,
        cwd,
      },
    };
  }

  if (type === "http" || type === "ws") {
    if (typeof raw.url !== "string" || !raw.url.trim()) {
      return { warning: `MCP server "${name}": ${type} transport requires a non-empty "url", skipping.` };
    }
    try {
      // Validate URL early so bad entries fail at config load, not connect time.
      new URL(raw.url);
    } catch {
      return { warning: `MCP server "${name}": invalid url "${raw.url}", skipping.` };
    }
    return type === "http"
      ? { config: { type: "http", url: raw.url } }
      : { config: { type: "ws", url: raw.url } };
  }

  return { warning: `MCP server "${name}": unknown transport type "${String(type)}", skipping.` };
}

/** Global MCP config path: `~/.orin/mcp.json`. */
export function mcpConfigPath(): string {
  return join(homedir(), ".orin", "mcp.json");
}

/** Load global MCP config. Missing or invalid file → empty config + warnings. */
export function loadMcpConfig(): { config: McpConfig; warnings: string[] } {
  const path = mcpConfigPath();
  if (!existsSync(path)) return { config: EMPTY, warnings: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      config: EMPTY,
      warnings: [`Failed to parse ${path}: ${message}`],
    };
  }

  if (!isRecord(parsed)) {
    return { config: EMPTY, warnings: [`${path}: expected a JSON object at the root.`] };
  }

  const rawServers = parsed.servers;
  if (rawServers === undefined) return { config: EMPTY, warnings: [] };
  if (!isRecord(rawServers)) {
    return { config: EMPTY, warnings: [`${path}: "servers" must be an object.`] };
  }

  const servers: Record<string, McpServerConfig> = {};
  const warnings: string[] = [];

  for (const [name, entry] of Object.entries(rawServers)) {
    const result = parseServerEntry(name, entry);
    if (result.warning) warnings.push(result.warning);
    else if (result.config) servers[name] = result.config;
  }

  return { config: { servers }, warnings };
}

/** Persist MCP config to `~/.orin/mcp.json`. */
export function saveMcpConfig(config: McpConfig): void {
  const path = mcpConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function upsertMcpServer(
  name: string,
  server: McpServerConfig,
  opts?: { replace?: string },
): { config: McpConfig; warnings: string[] } {
  const { config, warnings } = loadMcpConfig();
  const servers = { ...config.servers };
  if (opts?.replace && opts.replace !== name) delete servers[opts.replace];
  servers[name] = server;
  const next = { servers };
  saveMcpConfig(next);
  return { config: next, warnings };
}

export function removeMcpServer(name: string): McpConfig {
  const { config } = loadMcpConfig();
  const servers = { ...config.servers };
  delete servers[name];
  const next = { servers };
  saveMcpConfig(next);
  return next;
}
