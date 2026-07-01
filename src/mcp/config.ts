import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  expandEnvList,
  expandEnvRecord,
  expandEnvString,
  formatMissingVars,
} from "./env-expand.js";
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

function hasEnvPlaceholder(value: string): boolean {
  return /\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*/.test(value);
}

/** Apply `${env:VAR}` / `${VAR}` expansion to all string fields of a server config. */
function expandServerEnv(
  config: McpServerConfig,
  env: NodeJS.ProcessEnv,
): { config: McpServerConfig; missing: string[] } {
  const missingSet = new Set<string>();
  const track = (m: string[]): void => {
    for (const v of m) missingSet.add(v);
  };

  switch (config.type) {
    case "stdio": {
      const commandR = expandEnvString(config.command, env);
      track(commandR.missing);
      const argsR = config.args
        ? expandEnvList(config.args, env)
        : undefined;
      if (argsR) track(argsR.missing);
      const envR = config.env ? expandEnvRecord(config.env, env) : undefined;
      if (envR) track(envR.missing);
      const cwdR = config.cwd !== undefined ? expandEnvString(config.cwd, env) : undefined;
      if (cwdR) track(cwdR.missing);
      return {
        config: {
          ...config,
          command: commandR.value,
          args: argsR?.value,
          env: envR?.value,
          cwd: cwdR?.value,
        },
        missing: [...missingSet],
      };
    }
    case "http": {
      const urlR = expandEnvString(config.url, env);
      track(urlR.missing);
      const headersR = config.headers ? expandEnvRecord(config.headers, env) : undefined;
      if (headersR) track(headersR.missing);
      return {
        config: {
          ...config,
          url: urlR.value,
          headers: headersR?.value,
        },
        missing: [...missingSet],
      };
    }
    case "ws": {
      const urlR = expandEnvString(config.url, env);
      track(urlR.missing);
      const headersR = config.headers ? expandEnvRecord(config.headers, env) : undefined;
      if (headersR) track(headersR.missing);
      return {
        config: {
          ...config,
          url: urlR.value,
          headers: headersR?.value,
        },
        missing: [...missingSet],
      };
    }
  }
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
    if (!hasEnvPlaceholder(raw.url)) {
      try {
        new URL(raw.url);
      } catch {
        return { warning: `MCP server "${name}": invalid url "${raw.url}", skipping.` };
      }
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
  // Prefer `process.env.HOME` so tests that point HOME at a temp dir can isolate
  // from the real user config (Bun caches `os.homedir()`, so we can't rely on it
  // picking up a HOME change made after process start).
  const home = process.env.HOME || homedir();
  return join(home, ".orin", "mcp.json");
}

/**
 * Parse and validate the on-disk MCP config. Returns the *unexpanded* config
 * (placeholders intact) so save-back paths don't leak resolved secrets.
 */
function loadMcpConfigRaw(): { config: McpConfig; warnings: string[] } {
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

/** Load global MCP config. Missing or invalid file → empty config + warnings. */
export function loadMcpConfig(
  env: NodeJS.ProcessEnv = process.env,
): { config: McpConfig; warnings: string[] } {
  const { config: rawConfig, warnings } = loadMcpConfigRaw();

  // Expand `${env:VAR}` / `${VAR}` placeholders at load time. The raw values
  // (with placeholders) are kept on disk; secrets never live in mcp.json.
  const expanded: Record<string, McpServerConfig> = {};
  for (const [name, serverConfig] of Object.entries(rawConfig.servers)) {
    const r = expandServerEnv(serverConfig, env);
    if (r.missing.length > 0) {
      warnings.push(
        `MCP server "${name}": missing required env var(s) ${formatMissingVars(r.missing)}; skipping. Set them and reload.`,
      );
      continue;
    }
    const expandedConfig = r.config;
    if (expandedConfig.type === "stdio" && !expandedConfig.command.trim()) {
      warnings.push(
        `MCP server "${name}": stdio transport requires a non-empty "command" after env expansion, skipping.`,
      );
      continue;
    }
    if (
      (expandedConfig.type === "http" || expandedConfig.type === "ws") &&
      (serverConfig.type === "http" || serverConfig.type === "ws") &&
      hasEnvPlaceholder(serverConfig.url)
    ) {
      try {
        new URL(expandedConfig.url);
      } catch {
        warnings.push(
          `MCP server "${name}": invalid url after env expansion, skipping.`,
        );
        continue;
      }
    }
    expanded[name] = expandedConfig;
  }

  return { config: { servers: expanded }, warnings };
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
  const { config, warnings } = loadMcpConfigRaw();
  const servers = { ...config.servers };
  if (opts?.replace && opts.replace !== name) delete servers[opts.replace];
  servers[name] = server;
  const next = { servers };
  saveMcpConfig(next);
  return { config: next, warnings };
}

export function removeMcpServer(name: string): McpConfig {
  const { config } = loadMcpConfigRaw();
  const servers = { ...config.servers };
  delete servers[name];
  deleteMcpOAuthStore(name);
  const next = { servers };
  saveMcpConfig(next);
  return next;
}
