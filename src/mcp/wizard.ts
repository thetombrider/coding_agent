import type { McpServerConfig, McpTransportType } from "./config.js";

export type McpWizardMode = "add" | "edit";

export type McpWizardStepId = "name" | "transport" | "command" | "args" | "url";

export interface McpWizardState {
  mode: McpWizardMode;
  /** Original server name when editing (for rename/replace). */
  originalName?: string;
  name: string;
  transport?: McpTransportType;
  command: string;
  args: string;
  url: string;
  stepIndex: number;
}

export interface McpWizardStep {
  id: McpWizardStepId;
  title: string;
  hint: string;
  optional?: boolean;
}

const TRANSPORTS: readonly McpTransportType[] = ["stdio", "http", "ws"];

export function beginAddWizard(): McpWizardState {
  return {
    mode: "add",
    name: "",
    command: "",
    args: "",
    url: "",
    stepIndex: 0,
  };
}

export function beginEditWizard(name: string, config: McpServerConfig): McpWizardState {
  return {
    mode: "edit",
    originalName: name,
    name,
    transport: config.type,
    command: config.type === "stdio" ? config.command : "",
    args: config.type === "stdio" ? (config.args ?? []).join(" ") : "",
    url: config.type === "http" || config.type === "ws" ? config.url : "",
    stepIndex: 0,
  };
}

export function wizardSteps(state: McpWizardState): McpWizardStep[] {
  const steps: McpWizardStep[] = [];
  if (state.mode === "add") {
    steps.push({
      id: "name",
      title: "Server name",
      hint: "Unique name (e.g. fs, github) · letters, numbers, dashes, underscores",
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
  } else if (state.transport === "http" || state.transport === "ws") {
    steps.push({
      id: "url",
      title: "URL",
      hint: state.transport === "http" ? "HTTP MCP endpoint URL" : "WebSocket MCP endpoint URL (wss://…)",
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
      return null;
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
  return state.transport === "http"
    ? { type: "http", url: state.url.trim() }
    : { type: "ws", url: state.url.trim() };
}

export function formatServerConfigSummary(config: McpServerConfig): string {
  switch (config.type) {
    case "stdio": {
      const parts = [config.command, ...(config.args ?? [])].join(" ");
      return `stdio · ${parts}`;
    }
    case "http":
      return `http · ${config.url}`;
    case "ws":
      return `ws · ${config.url}`;
  }
}
