import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parseMcpOAuth, type McpOAuthOptions } from "./oauth-config.js";
import { deleteMcpOAuthStore } from "./oauth-store.js";

export type { McpOAuthOptions };

export type McpStdioConfig = {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
};

export type McpHttpConfig = {
  type: "http";
  url: string;
  /** Optional request headers (e.g. Authorization for authenticated endpoints). */
  headers?: Record<string, string>;
  /** Enable MCP OAuth 2.1 (`true` or static client registration). */
  oauth?: true | McpOAuthOptions;
  disabled?: boolean;
};

export type McpWsConfig = {
  type: "ws";
  url: string;
  headers?: Record<string, string>;
  disabled?: boolean;
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

function parseDisabled(raw: Record<string, unknown>): boolean | undefined {
  return raw.disabled === true ? true : undefined;
}

function parseServerEntry(name: string, raw: unknown): { config?: McpServerConfig; warning?: string } {
  if (!isRecord(raw)) {
    return { warning: `MCP server "${name}": expected an object, skipping.` };
  }

  const disabled = parseDisabled(raw);
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
        disabled,
      },
    };
  }

  if (type === "http" || type === "ws") {
    if (typeof raw.url !== "string" || !raw.url.trim()) {
      return { warning: `MCP server "${name}": ${type} transport requires a non-empty "url", skipping.` };
    }
    try {
      new URL(raw.url);
    } catch {
      return { warning: `MCP server "${name}": invalid url "${raw.url}", skipping.` };
    }
    const headers =
      raw.headers === undefined
        ? undefined
        : isRecord(raw.headers) &&
            Object.entries(raw.headers).every(([k, v]) => typeof k === "string" && typeof v === "string")
          ? (raw.headers as Record<string, string>)
          : undefined;
    if (raw.headers !== undefined && headers === undefined) {
      return { warning: `MCP server "${name}": "headers" must be a string map, skipping.` };
    }
    const oauth = parseMcpOAuth(raw.oauth);
    if (raw.oauth !== undefined && oauth === undefined) {
      return { warning: `MCP server "${name}": "oauth" must be true or an object, skipping.` };
    }
    return type === "http"
      ? { config: { type: "http", url: raw.url, headers, oauth, disabled } }
      : { config: { type: "ws", url: raw.url, headers, disabled } };
  }

  return { warning: `MCP server "${name}": unknown transport type "${String(type)}", skipping.` };
}

/** Common misconfig: wizard/tests placeholder `npx -y server` instead of the filesystem package. */
export const FILESYSTEM_MCP_NPX_ARGS = ["-y", "@modelcontextprotocol/server-filesystem", "."] as const;

export function repairFilesystemStdioConfig(config: McpStdioConfig): {
  config: McpStdioConfig;
  repaired: boolean;
} {
  if (
    config.command === "npx" &&
    config.args?.length === 2 &&
    config.args[0] === "-y" &&
    config.args[1] === "server"
  ) {
    return {
      config: { ...config, args: [...FILESYSTEM_MCP_NPX_ARGS] },
      repaired: true,
    };
  }
  return { config, repaired: false };
}

function repairLoadedServers(servers: Record<string, McpServerConfig>): {
  servers: Record<string, McpServerConfig>;
  warnings: string[];
  changed: boolean;
} {
  const warnings: string[] = [];
  let changed = false;
  const next: Record<string, McpServerConfig> = {};

  for (const [name, server] of Object.entries(servers)) {
    if (server.type !== "stdio") {
      next[name] = server;
      continue;
    }
    const { config, repaired } = repairFilesystemStdioConfig(server);
    next[name] = config;
    if (repaired) {
      changed = true;
      warnings.push(
        `MCP server "${name}": repaired stdio args from "npx -y server" to @modelcontextprotocol/server-filesystem .`,
      );
    }
  }

  return { servers: next, warnings, changed };
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

  const repaired = repairLoadedServers(servers);
  warnings.push(...repaired.warnings);
  if (repaired.changed) {
    saveMcpConfig({ servers: repaired.servers });
  }

  return { config: { servers: repaired.servers }, warnings };
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
  deleteMcpOAuthStore(name);
  const next = { servers };
  saveMcpConfig(next);
  return next;
}
