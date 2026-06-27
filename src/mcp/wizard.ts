import type { McpOAuthOptions } from "./oauth-config.js";
import type { McpServerConfig, McpTransportType } from "./config.js";
import { isMcpOAuthConfigured } from "./oauth-config.js";

export type McpWizardMode = "add" | "edit";

export type McpAuthMode = "none" | "bearer" | "oauth";

export type McpWizardStepId =
  | "name"
  | "transport"
  | "command"
  | "args"
  | "url"
  | "authMode"
  | "token"
  | "oauthClientId"
  | "oauthClientSecret"
  | "oauthScopes";

export interface McpWizardState {
  mode: McpWizardMode;
  /** Original server name when editing (for rename/replace). */
  originalName?: string;
  name: string;
  transport?: McpTransportType;
  command: string;
  args: string;
  url: string;
  authMode: McpAuthMode;
  /** Bearer/API token for http/ws (stored as Authorization header). */
  token: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScopes: string;
  stepIndex: number;
}

export interface McpWizardStep {
  id: McpWizardStepId;
  title: string;
  hint: string;
  optional?: boolean;
}

const TRANSPORTS: readonly McpTransportType[] = ["stdio", "http", "ws"];
const AUTH_MODES: readonly McpAuthMode[] = ["none", "bearer", "oauth"];

function emptyWizardFields(): Pick<
  McpWizardState,
  "authMode" | "token" | "oauthClientId" | "oauthClientSecret" | "oauthScopes"
> {
  return {
    authMode: "none",
    token: "",
    oauthClientId: "",
    oauthClientSecret: "",
    oauthScopes: "",
  };
}

export function beginAddWizard(): McpWizardState {
  return {
    mode: "add",
    name: "",
    command: "",
    args: "",
    url: "",
    stepIndex: 0,
    ...emptyWizardFields(),
  };
}

function authModeFromConfig(config: McpServerConfig): McpAuthMode {
  if (config.type === "http" && isMcpOAuthConfigured(config)) return "oauth";
  if (config.type === "http" || config.type === "ws") {
    const authHeader = config.headers?.Authorization ?? config.headers?.authorization;
    if (authHeader?.trim()) return "bearer";
  }
  return "none";
}

function oauthFieldsFromConfig(config: McpServerConfig): Pick<
  McpWizardState,
  "oauthClientId" | "oauthClientSecret" | "oauthScopes"
> {
  if (config.type !== "http" || config.oauth === undefined || config.oauth === true) {
    return { oauthClientId: "", oauthClientSecret: "", oauthScopes: "" };
  }
  return {
    oauthClientId: config.oauth.clientId ?? "",
    oauthClientSecret: config.oauth.clientSecret ?? "",
    oauthScopes: config.oauth.scopes?.join(" ") ?? "",
  };
}

export function beginEditWizard(name: string, config: McpServerConfig): McpWizardState {
  const token =
    config.type === "http" || config.type === "ws"
      ? (config.headers?.Authorization ?? config.headers?.authorization ?? "")
      : "";
  return {
    mode: "edit",
    originalName: name,
    name,
    transport: config.type,
    command: config.type === "stdio" ? config.command : "",
    args: config.type === "stdio" ? (config.args ?? []).join(" ") : "",
    url: config.type === "http" || config.type === "ws" ? config.url : "",
    authMode: authModeFromConfig(config),
    token,
    ...oauthFieldsFromConfig(config),
    stepIndex: 0,
  };
}

function parseAuthMode(raw: string): McpAuthMode | null {
  const v = raw.trim().toLowerCase();
  return AUTH_MODES.includes(v as McpAuthMode) ? (v as McpAuthMode) : null;
}

export function wizardSteps(state: McpWizardState): McpWizardStep[] {
  const steps: McpWizardStep[] = [];
  if (state.mode === "add") {
    steps.push({
      id: "name",
      title: "Server name",
      hint: "Unique name (e.g. fs, github, context7) · letters, numbers, dashes, underscores",
    });
  }
  steps.push({
    id: "transport",
    title: "Transport",
    hint: "stdio, http, or ws",
  });
  if (state.transport === "stdio") {
    steps.push({
      id: "command",
      title: "Command",
      hint: "Executable to run (e.g. npx, bun, node)",
    });
    steps.push({
      id: "args",
      title: "Arguments",
      hint: "Optional space-separated args (e.g. -y @modelcontextprotocol/server-filesystem .)",
      optional: true,
    });
  } else if (state.transport === "http") {
    steps.push({
      id: "url",
      title: "URL",
      hint: "HTTP MCP endpoint URL",
    });
    steps.push({
      id: "authMode",
      title: "Authentication",
      hint: "none · bearer (API token) · oauth (browser login — tokens stored separately)",
    });
    if (state.authMode === "bearer") {
      steps.push({
        id: "token",
        title: "Bearer token",
        hint: "API key or personal access token (sent as Authorization header)",
        optional: true,
      });
    } else if (state.authMode === "oauth") {
      steps.push({
        id: "oauthClientId",
        title: "OAuth client ID",
        hint: "Optional — leave blank for dynamic client registration",
        optional: true,
      });
      steps.push({
        id: "oauthClientSecret",
        title: "OAuth client secret",
        hint: "Optional — only if your provider issued a static client secret",
        optional: true,
      });
      steps.push({
        id: "oauthScopes",
        title: "OAuth scopes",
        hint: "Optional space- or comma-separated scopes",
        optional: true,
      });
    }
  } else if (state.transport === "ws") {
    steps.push({
      id: "url",
      title: "URL",
      hint: "WebSocket MCP endpoint URL (wss://…)",
    });
    steps.push({
      id: "token",
      title: "Authorization token",
      hint: "Optional Bearer/API token (sent as Authorization header)",
      optional: true,
    });
  }
  return steps;
}

export function currentWizardStep(state: McpWizardState): McpWizardStep | undefined {
  return wizardSteps(state)[state.stepIndex];
}

export function wizardFieldValue(state: McpWizardState, step: McpWizardStepId): string {
  switch (step) {
    case "name":
      return state.name;
    case "transport":
      return state.transport ?? "";
    case "command":
      return state.command;
    case "args":
      return state.args;
    case "url":
      return state.url;
    case "authMode":
      return state.authMode;
    case "token":
      return state.token;
    case "oauthClientId":
      return state.oauthClientId;
    case "oauthClientSecret":
      return state.oauthClientSecret;
    case "oauthScopes":
      return state.oauthScopes;
  }
}

function parseTransport(raw: string): McpTransportType | null {
  const v = raw.trim().toLowerCase();
  return TRANSPORTS.includes(v as McpTransportType) ? (v as McpTransportType) : null;
}

function validServerName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

export function validateWizardStep(
  _state: McpWizardState,
  step: McpWizardStep,
  raw: string,
): string | null {
  const value = raw.trim();
  if (!value && !step.optional) return "value required";

  switch (step.id) {
    case "name":
      if (!validServerName(value)) {
        return "name must use letters, numbers, dashes, or underscores only";
      }
      return null;
    case "transport": {
      if (!value) return "transport required";
      if (!parseTransport(value)) return "transport must be stdio, http, or ws";
      return null;
    }
    case "command":
      if (!value) return "command required";
      return null;
    case "args":
    case "token":
    case "oauthClientId":
    case "oauthClientSecret":
    case "oauthScopes":
      return null;
    case "authMode": {
      if (!value) return "authentication required — enter none, bearer, or oauth";
      if (!parseAuthMode(value)) return "authentication must be none, bearer, or oauth";
      return null;
    }
    case "url":
      if (!value) return "url required";
      try {
        new URL(value);
      } catch {
        return "invalid URL";
      }
      return null;
  }
}

export function applyWizardStep(
  state: McpWizardState,
  step: McpWizardStep,
  raw: string,
): McpWizardState {
  const value = raw.trim();
  const next: McpWizardState = { ...state };

  switch (step.id) {
    case "name":
      next.name = value;
      break;
    case "transport":
      next.transport = parseTransport(value) ?? undefined;
      if (next.transport !== "http") {
        next.authMode = "none";
        next.oauthClientId = "";
        next.oauthClientSecret = "";
        next.oauthScopes = "";
      }
      break;
    case "command":
      next.command = value;
      break;
    case "args":
      next.args = value;
      break;
    case "url":
      next.url = value;
      break;
    case "authMode":
      next.authMode = parseAuthMode(value) ?? "none";
      if (next.authMode !== "bearer") next.token = "";
      if (next.authMode !== "oauth") {
        next.oauthClientId = "";
        next.oauthClientSecret = "";
        next.oauthScopes = "";
      }
      break;
    case "token":
      next.token = value;
      break;
    case "oauthClientId":
      next.oauthClientId = value;
      break;
    case "oauthClientSecret":
      next.oauthClientSecret = value;
      break;
    case "oauthScopes":
      next.oauthScopes = value;
      break;
  }

  const steps = wizardSteps(next);
  const nextIndex = state.stepIndex + 1;
  if (nextIndex >= steps.length) {
    return { ...next, stepIndex: steps.length };
  }
  return { ...next, stepIndex: nextIndex };
}

export function wizardComplete(state: McpWizardState): boolean {
  return state.stepIndex >= wizardSteps(state).length;
}

export function authorizationHeader(token: string): Record<string, string> | undefined {
  const trimmed = token.trim();
  if (!trimmed) return undefined;
  const value = /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
  return { Authorization: value };
}

function buildOAuthOptions(state: McpWizardState): true | McpOAuthOptions {
  const clientId = state.oauthClientId.trim();
  const clientSecret = state.oauthClientSecret.trim();
  const scopesRaw = state.oauthScopes.trim();
  if (!clientId && !clientSecret && !scopesRaw) return true;
  return {
    clientId: clientId || undefined,
    clientSecret: clientSecret || undefined,
    scopes: scopesRaw
      ? scopesRaw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
      : undefined,
  };
}

export function wizardToServerConfig(state: McpWizardState): McpServerConfig | null {
  if (!state.transport) return null;
  if (state.transport === "stdio") {
    if (!state.command.trim()) return null;
    const args = state.args.trim()
      ? state.args.trim().split(/\s+/).filter(Boolean)
      : undefined;
    return { type: "stdio", command: state.command.trim(), args };
  }
  if (!state.url.trim()) return null;

  if (state.transport === "http") {
    const base = { type: "http" as const, url: state.url.trim() };
    if (state.authMode === "oauth") {
      return { ...base, oauth: buildOAuthOptions(state) };
    }
    const headers = state.authMode === "bearer" ? authorizationHeader(state.token) : undefined;
    return headers ? { ...base, headers } : base;
  }

  const headers = authorizationHeader(state.token);
  return headers
    ? { type: "ws", url: state.url.trim(), headers }
    : { type: "ws", url: state.url.trim() };
}

export function hasMcpAuth(config: McpServerConfig): boolean {
  if (config.type !== "http" && config.type !== "ws") return false;
  return Boolean(config.headers && Object.keys(config.headers).length > 0);
}

export function mcpAuthModeLabel(config: McpServerConfig): "oauth" | "bearer" | "none" {
  if (config.type === "http" && isMcpOAuthConfigured(config)) return "oauth";
  if (hasMcpAuth(config)) return "bearer";
  return "none";
}

export function formatServerConfigSummary(config: McpServerConfig): string {
  switch (config.type) {
    case "stdio": {
      const parts = [config.command, ...(config.args ?? [])].join(" ");
      return `stdio · ${parts}`;
    }
    case "http": {
      const auth = mcpAuthModeLabel(config);
      const authSuffix = auth === "none" ? "" : ` · ${auth}`;
      return `http · ${config.url}${authSuffix}`;
    }
    case "ws":
      return `ws · ${config.url}${hasMcpAuth(config) ? " · bearer" : ""}`;
  }
}

/** Whether /mcp detail can run OAuth authenticate (or enable OAuth first). */
export function wizardNeedsOAuthAfterSave(state: McpWizardState): boolean {
  return state.transport === "http" && state.authMode === "oauth";
}
