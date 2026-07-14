import {
  APPROVAL_MODE_LABELS,
  APPROVAL_MODES,
  coerceApprovalMode,
  nextApprovalMode,
  type ApprovalMode,
} from "../approval/policy.js";
import {
  coerceIsolation,
  ISOLATION_LABELS,
  ISOLATION_MODES,
  type IsolationMode,
} from "../agent/isolation.js";
import {
  coerceSessionIsolation,
  SESSION_ISOLATION_LABELS,
  SESSION_ISOLATION_MODES,
  type SessionIsolationMode,
} from "../agent/session-isolation.js";
import {
  PARALLEL_SUBAGENT_INFO,
  PARALLEL_SUBAGENT_MENU_VALUE,
  effectiveSerialSubagentMenuValue,
  serialSubagentPaletteHeader,
  workspaceSettingsOverview,
} from "../agent/workspace-settings.js";
import { hasE2BApiKey, hasExaApiKey, loadConfig, saveConfig } from "../config/config.js";
import type { ModelPricing } from "../config/config.js";
import { resolveDisplayModelPricing } from "../config/model-pricing.js";
import { resolveModelOnProviderSwitch } from "../provider/picker-models.js";
import type { ProviderSummary } from "../provider/registry.js";
import type { ProviderConfigField } from "../provider/types.js";

export interface CommandContext {
  currentModel: string;
  currentMode: ApprovalMode;
  /** Configured subagent isolation floor (`subagent.isolation`). */
  currentIsolation?: IsolationMode;
  /** Configured session isolation (`session.isolation`). */
  currentSessionIsolation?: SessionIsolationMode;
  /** Live session branch when the parent runs in session worktree mode. */
  liveSessionBranch?: string;
  /** Live parent cwd (session worktree dir or host checkout). */
  liveCwd?: string;
  /** Live session isolation for this run (may differ before config catches up). */
  liveSessionIsolation?: SessionIsolationMode;
  /** Configured OTLP content-capture opt-in (`telemetry.otel.captureContent`). */
  currentCaptureContent?: boolean;
  knownModels: readonly string[];
  currentProvider?: string;
  providers?: ProviderSummary[];
  /** Optional lookup injected by the TUI for configure flows. */
  providerConfigFields?: (id: string) => readonly ProviderConfigField[];
  /** Static pricing table for model list labels. */
  modelPricing?: Record<string, ModelPricing>;
}

export type CommandResult =
  | { type: "not-command" }
  | { type: "exit" }
  | { type: "clear" }
  | { type: "new" }
  | { type: "skills"; name?: string }
  | { type: "skill"; name: string; task?: string }
  | { type: "checkpoints" }
  | { type: "restore"; id?: string }
  | { type: "set-model"; model: string; message: string }
  | { type: "set-mode"; mode: ApprovalMode; message: string }
  | { type: "set-isolation"; isolation: IsolationMode; message: string }
  | { type: "set-session-isolation"; isolation: SessionIsolationMode; message: string }
  | { type: "set-telemetry-capture"; enabled: boolean; message: string }
  | { type: "set-provider"; provider: string; model?: string; message: string }
  | {
      type: "configure-provider";
      provider: string;
      fields: readonly ProviderConfigField[];
      activateOnComplete: boolean;
      message: string;
    }
  | { type: "configure-e2b"; message: string }
  | { type: "configure-exa"; message: string }
  | { type: "open-mcp" }
  | { type: "open-settings" }
  | { type: "toggle-panels"; target: PanelTarget }
  | { type: "show-panels"; visible: boolean }
  | { type: "focus-sessions" }
  | { type: "info"; message: string }
  | { type: "error"; message: string };

import { clipboardHintText } from "./shortcuts.js";
import { formatModelPricingLabel } from "./views.js";
import type { PanelTarget } from "./sidebar-state.js";

/** List of `/commands` shown by `/help`. */
export const KEYBOARD_HINTS = clipboardHintText();

const HELP_LINES = [
  "/mode [normal|allow-all|plan]  cycle or set approval mode",
  "/model [id|number]            switch the model",
  "/providers [id|number]        list or switch the active LLM provider",
  "/providers configure [id]     set API keys / provider settings in ~/.orin/config.json",
  "/settings                     open settings (E2B key, isolation, telemetry, task models)",
  "/settings isolation [mode]    set subagent isolation floor (shared|worktree|sandbox)",
  "/settings session-isolation [mode]  set session isolation (shared|worktree)",
  "/settings telemetry [on|off]  opt in/out of prompt+response capture on OTLP spans",
  "/settings loop [turns tools]     per-turn main-agent round/tool caps (0 = unlimited)",
  "/settings e2b                 configure E2B API key (for sandbox isolation)",
  "/settings exa                 configure Exa API key (for web_search tool)",
  "/mcp                          browse and configure MCP servers",
  "/sessions                     focus the sessions sidebar",
  "/panels [left|right|all|on|off]  toggle sidebars (Ctrl+\\ toggles both)",
  "/skills [name]                browse skills, or show one skill's metadata",
  "/skill <name> [task]          ask the agent to use a skill",
  "/checkpoints                  list workspace checkpoints for this session",
  "/restore [id]                 roll the working tree back (latest checkpoint if no id)",
  "/new                          archive this session and start a new one",
  "/clear                        clear the conversation",
  "/help                         show this help",
  "/exit                         quit (Ctrl+C when idle)",
];

function modeInfo(ctx: CommandContext): string {
  const opts = APPROVAL_MODES.map(
    (m) => `${APPROVAL_MODE_LABELS[m]}${m === ctx.currentMode ? " (current)" : ""}`,
  ).join(" · ");
  return `mode: ${opts} — /mode <name> or /mode to cycle`;
}

function modelInfo(ctx: CommandContext): string {
  const providerId = ctx.currentProvider ?? "openrouter";
  const pricingTable = ctx.modelPricing ?? {};
  const lines = ctx.knownModels.map((m, i) => {
    const marker = m === ctx.currentModel ? " ←" : "";
    const price = formatModelPricingLabel(
      resolveDisplayModelPricing(m, providerId, pricingTable),
    );
    return `${i + 1}. ${m}  ${price}${marker}`;
  });
  return `model: ${ctx.currentModel}\n${lines.join("\n")}\n/model <number|id> to switch`;
}

function handlePanels(arg: string): CommandResult {
  const target = arg.trim().toLowerCase();
  if (!target) return { type: "toggle-panels", target: "all" };
  if (target === "left" || target === "sessions") return { type: "toggle-panels", target: "left" };
  if (target === "right" || target === "info") return { type: "toggle-panels", target: "right" };
  if (target === "all" || target === "toggle") return { type: "toggle-panels", target: "all" };
  if (target === "on" || target === "show") return { type: "show-panels", visible: true };
  if (target === "off" || target === "hide" || target === "none") {
    return { type: "show-panels", visible: false };
  }
  return {
    type: "error",
    message: "usage: /panels [left|right|all|on|off] — Ctrl+\\ toggles both sidebars",
  };
}

function handleMode(arg: string, ctx: CommandContext): CommandResult {
  if (!arg) {
    const next = nextApprovalMode(ctx.currentMode);
    return {
      type: "set-mode",
      mode: next,
      message: `mode → ${APPROVAL_MODE_LABELS[next]}`,
    };
  }
  const mode = coerceApprovalMode(arg);
  if (!mode) {
    return {
      type: "error",
      message: `unknown mode "${arg}". ${modeInfo(ctx)}`,
    };
  }
  if (mode === ctx.currentMode) {
    return { type: "info", message: `already in ${APPROVAL_MODE_LABELS[mode]} mode` };
  }
  return {
    type: "set-mode",
    mode,
    message: `mode → ${APPROVAL_MODE_LABELS[mode]}`,
  };
}

function handleModel(arg: string, ctx: CommandContext): CommandResult {
  if (!arg) {
    return { type: "info", message: modelInfo(ctx) };
  }

  let model = arg;
  if (/^\d+$/.test(arg)) {
    const idx = Number(arg) - 1;
    const picked = ctx.knownModels[idx];
    if (!picked) {
      return {
        type: "error",
        message: `no model #${arg}. ${modelInfo(ctx)}`,
      };
    }
    model = picked;
  }

  if (model === ctx.currentModel) {
    return { type: "info", message: `already using ${model}` };
  }
  return { type: "set-model", model, message: `model → ${model}` };
}

function providerInfo(ctx: CommandContext): string {
  const providers = ctx.providers ?? [];
  if (!providers.length) return "no providers registered";
  const lines = providers.map((p, i) => {
    const marker = p.active ? " ←" : "";
    const status = p.configured ? "" : "  (needs setup)";
    return `${i + 1}. ${p.id}${status}${marker}`;
  });
  return `provider: ${ctx.currentProvider ?? "?"}\n${lines.join("\n")}\n/providers <number|id> to switch · /providers configure <id>`;
}

function resolveProviderTarget(
  arg: string,
  providers: ProviderSummary[],
): ProviderSummary | { error: string } {
  if (!arg) {
    return { error: "missing provider id — pick one from the list below" };
  }

  let target = arg;
  if (/^\d+$/.test(arg)) {
    const picked = providers[Number(arg) - 1];
    if (!picked) {
      return { error: `no provider #${arg}` };
    }
    target = picked.id;
  }

  const match = providers.find((p) => p.id === target);
  if (!match) {
    return { error: `unknown provider "${target}"` };
  }
  return match;
}

function configureFieldHint(fields: readonly ProviderConfigField[]): string {
  const field = fields[0];
  if (!field) return "nothing to configure";
  return `enter ${field.label}`;
}

function handleProviderConfigure(arg: string, ctx: CommandContext): CommandResult {
  const providers = ctx.providers ?? [];
  if (!providers.length) {
    return { type: "error", message: "no providers registered" };
  }

  if (!arg) {
    const lines = providers.map((p, i) => {
      const status = p.configured ? "" : "  (needs setup)";
      return `${i + 1}. ${p.id}${status}`;
    });
    return {
      type: "info",
      message: `configure a provider:\n${lines.join("\n")}\n/providers configure <number|id>`,
    };
  }

  const resolved = resolveProviderTarget(arg, providers);
  if ("error" in resolved) {
    return { type: "error", message: `${resolved.error}. ${providerInfo(ctx)}` };
  }

  const fields = ctx.providerConfigFields?.(resolved.id) ?? [];

  if (!fields.length) {
    return {
      type: "error",
      message: `${resolved.id} has no TUI-configurable fields yet.`,
    };
  }

  return {
    type: "configure-provider",
    provider: resolved.id,
    fields,
    activateOnComplete: false,
    message: `Configure ${resolved.displayName}: ${configureFieldHint(fields)} · Esc to cancel`,
  };
}

function handleProviderSwitch(arg: string, ctx: CommandContext): CommandResult {
  const providers = ctx.providers ?? [];
  if (!arg) {
    return { type: "info", message: providerInfo(ctx) };
  }

  let target = arg;
  if (/^\d+$/.test(arg)) {
    const picked = providers[Number(arg) - 1];
    if (!picked) {
      return { type: "error", message: `no provider #${arg}. ${providerInfo(ctx)}` };
    }
    target = picked.id;
  }

  const match = providers.find((p) => p.id === target);
  if (!match) {
    return { type: "error", message: `unknown provider "${target}". ${providerInfo(ctx)}` };
  }
  if (match.active) {
    return { type: "info", message: `already using ${match.id}` };
  }
  const warn = match.configured
    ? ""
    : " (not configured — run /providers configure " + match.id + ")";
  let message = `provider → ${match.id}${warn}`;
  const fromProvider = ctx.currentProvider ?? "openrouter";
  const { model, note } = resolveModelOnProviderSwitch(fromProvider, match.id, ctx.currentModel);
  message += note;
  return { type: "set-provider", provider: match.id, model, message };
}

function liveSessionMode(ctx: CommandContext): SessionIsolationMode {
  return ctx.liveSessionIsolation ?? ctx.currentSessionIsolation ?? "shared";
}

function isolationInfo(ctx: CommandContext): string {
  const floor = ctx.currentIsolation ?? "shared";
  const serial = effectiveSerialSubagentMenuValue(liveSessionMode(ctx), floor);
  if (liveSessionMode(ctx) === "worktree") {
    return (
      `${serialSubagentPaletteHeader("worktree")}\n\n`
      + `Effective serial task behavior: ${serial}\n`
      + `Stored floor (applies on host tree): ${floor}\n`
      + `Parallel task_parallel: ${PARALLEL_SUBAGENT_MENU_VALUE}\n\n`
      + PARALLEL_SUBAGENT_INFO
    );
  }
  const current = floor;
  const options = ISOLATION_MODES.map((m) => `  ${m === current ? "›" : " "} ${ISOLATION_LABELS[m]}`);
  return (
    `Serial task subagent floor: ${current} (model may escalate, never weaken)\n`
    + `${options.join("\n")}\n`
    + `Parallel task_parallel: ${PARALLEL_SUBAGENT_MENU_VALUE}\n`
    + "/settings isolation <shared|worktree|sandbox> to change"
  );
}

function sessionIsolationInfo(ctx: CommandContext): string {
  const current = ctx.currentSessionIsolation ?? "shared";
  const options = SESSION_ISOLATION_MODES.map(
    (m) => `  ${m === current ? "›" : " "} ${SESSION_ISOLATION_LABELS[m]}`,
  );
  return (
    `Parent workspace (config): ${current}\n`
    + `${options.join("\n")}\n`
    + "/settings session-isolation <shared|worktree> to change"
  );
}

function handleIsolation(value: string | undefined, ctx: CommandContext): CommandResult {
  if (!value) {
    return { type: "info", message: isolationInfo(ctx) };
  }
  const mode = coerceIsolation(value);
  if (!mode) {
    return {
      type: "error",
      message: `unknown isolation "${value}" — use shared, worktree, or sandbox`,
    };
  }
  if (mode === (ctx.currentIsolation ?? "shared")) {
    return { type: "info", message: `subagent isolation already ${mode}` };
  }
  return { type: "set-isolation", isolation: mode, message: `subagent isolation → ${mode}` };
}

function handleSessionIsolation(value: string | undefined, ctx: CommandContext): CommandResult {
  if (!value) {
    return { type: "info", message: sessionIsolationInfo(ctx) };
  }
  const mode = coerceSessionIsolation(value);
  if (!mode) {
    return {
      type: "error",
      message: `unknown session isolation "${value}" — use shared or worktree`,
    };
  }
  if (mode === (ctx.currentSessionIsolation ?? "shared")) {
    return { type: "info", message: `session isolation already ${mode}` };
  }
  return {
    type: "set-session-isolation",
    isolation: mode,
    message: `session isolation → ${mode}`,
  };
}

function telemetryInfo(ctx: CommandContext): string {
  const on = ctx.currentCaptureContent ?? false;
  return (
    `telemetry content capture: ${on ? "on" : "off"} `
    + "(off by default for privacy)\n"
    + "When on, prompts, responses, and tool args/results are attached to OTLP "
    + "spans (only exported when an OTLP endpoint is configured).\n"
    + "/settings telemetry <on|off> to change"
  );
}

const TRUTHY = new Set(["on", "true", "yes", "1", "enable", "enabled"]);
const FALSY = new Set(["off", "false", "no", "0", "disable", "disabled"]);

function handleTelemetry(value: string | undefined, ctx: CommandContext): CommandResult {
  if (!value) {
    return { type: "info", message: telemetryInfo(ctx) };
  }
  const v = value.toLowerCase();
  if (!TRUTHY.has(v) && !FALSY.has(v)) {
    return { type: "error", message: `unknown value "${value}" — use on or off` };
  }
  const enabled = TRUTHY.has(v);
  if (enabled === (ctx.currentCaptureContent ?? false)) {
    return { type: "info", message: `telemetry content capture already ${enabled ? "on" : "off"}` };
  }
  return {
    type: "set-telemetry-capture",
    enabled,
    message: `telemetry content capture → ${enabled ? "on" : "off"}`,
  };
}

function loopLimitsInfo(): string {
  const { maxTurns, maxToolCalls } = loadConfig().agent;
  const turns = maxTurns > 0 ? String(maxTurns) : "unlimited";
  const tools = maxToolCalls > 0 ? String(maxToolCalls) : "unlimited";
  return (
    "Per-turn circuit breaker (main agent):\n"
    + `  max assistant rounds: ${turns}\n`
    + `  max tool calls: ${tools}\n`
    + "/settings loop <maxTurns> <maxToolCalls> to change (0 = unlimited)"
  );
}

function handleLoopLimits(parts: string[]): CommandResult {
  if (parts.length < 2) {
    return { type: "info", message: loopLimitsInfo() };
  }
  const maxTurns = Number(parts[1]);
  const maxToolCalls = Number(parts[2]);
  if (!Number.isFinite(maxTurns) || maxTurns < 0 || !Number.isFinite(maxToolCalls) || maxToolCalls < 0) {
    return {
      type: "error",
      message: "usage: /settings loop <maxTurns> <maxToolCalls> — non-negative integers; 0 disables a cap",
    };
  }
  saveConfig({
    agent: {
      maxTurns: Math.floor(maxTurns),
      maxToolCalls: Math.floor(maxToolCalls),
    },
  });
  const turns = maxTurns > 0 ? String(Math.floor(maxTurns)) : "unlimited";
  const tools = maxToolCalls > 0 ? String(Math.floor(maxToolCalls)) : "unlimited";
  return {
    type: "info",
    message: `main-agent loop limits → ${turns} rounds, ${tools} tool calls`,
  };
}

function handleSettings(arg: string, ctx: CommandContext): CommandResult {
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();

  if (!sub) {
    return { type: "open-settings" };
  }

  if (sub === "workspace") {
    if (!ctx.liveCwd) {
      return { type: "info", message: "Workspace summary is available in an active session." };
    }
    return {
      type: "info",
      message: workspaceSettingsOverview({
        sessionIsolation: liveSessionMode(ctx),
        sessionBranch: ctx.liveSessionBranch,
        cwd: ctx.liveCwd,
        subagentFloor: ctx.currentIsolation ?? "shared",
      }),
    };
  }

  if (sub === "isolation") {
    return handleIsolation(parts[1], ctx);
  }

  if (sub === "session-isolation" || sub === "session") {
    return handleSessionIsolation(parts[1], ctx);
  }

  if (sub === "telemetry" || sub === "capture") {
    return handleTelemetry(parts[1], ctx);
  }

  if (sub === "loop" || sub === "limits") {
    return handleLoopLimits(parts);
  }

  if (sub === "e2b") {
    if (hasE2BApiKey()) {
      return {
        type: "info",
        message:
          "E2B API key is configured — the task tool can spawn sandbox subagents. "
          + "Run /settings e2b to replace it.",
      };
    }
    return {
      type: "configure-e2b",
      message:
        "Configure E2B: paste your API key (required only for sandbox isolation — get one at "
        + "https://e2b.dev/docs/api-key) · Esc to cancel",
    };
  }

  if (sub === "exa") {
    if (hasExaApiKey()) {
      return {
        type: "info",
        message:
          "Exa API key is configured — the web_search tool is enabled. "
          + "Run /settings exa to replace it.",
      };
    }
    return {
      type: "configure-exa",
      message:
        "Configure Exa: paste your API key (get one at https://dashboard.exa.ai/api-keys) "
        + "· Esc to cancel",
    };
  }

  if (sub === "mcp") {
    return { type: "open-mcp" };
  }

  return {
    type: "error",
    message: `unknown setting "${sub}" — try /settings workspace, /settings isolation, /settings session-isolation, /settings loop, /settings telemetry, /settings e2b, /settings exa, or /settings mcp`,
  };
}

/** `/skills` opens the palette; `/skills <name>` shows one skill's metadata. */
function handleSkills(arg: string): CommandResult {
  const name = arg.trim();
  return { type: "skills", name: name || undefined };
}

/** `/skill <name> [task]` submits a user turn asking the agent to use a skill. */
function handleSkill(arg: string): CommandResult {
  const trimmed = arg.trim();
  if (!trimmed) {
    return { type: "error", message: "usage: /skill <name> [task] — or /skills to browse" };
  }
  const space = trimmed.indexOf(" ");
  const name = space === -1 ? trimmed : trimmed.slice(0, space);
  const task = space === -1 ? "" : trimmed.slice(space + 1).trim();
  return { type: "skill", name, task: task || undefined };
}

function handleProviders(arg: string, ctx: CommandContext): CommandResult {
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();
  if (sub === "configure" || sub === "config") {
    return handleProviderConfigure(parts.slice(1).join(" "), ctx);
  }
  return handleProviderSwitch(arg, ctx);
}

/**
 * Slash commands that mutate state or open a TUI flow. Informational results
 * (help text, errors) are not actionable — the command palette should handle Enter.
 */
export function isActionableCommandResult(result: CommandResult): boolean {
  switch (result.type) {
    case "exit":
    case "clear":
    case "new":
    case "focus-sessions":
    case "skills":
    case "skill":
    case "checkpoints":
    case "restore":
    case "set-model":
    case "set-mode":
    case "set-isolation":
    case "set-session-isolation":
    case "set-telemetry-capture":
    case "set-provider":
    case "configure-provider":
      return true;
    case "configure-e2b":
      return true;
    case "configure-exa":
      return true;
    case "open-settings":
    case "open-mcp":
    case "toggle-panels":
    case "show-panels":
      return true;
    default:
      return false;
  }
}

/**
 * Parse and resolve a submitted line. Returns `not-command` for anything that
 * is not a recognized `/command`, so the caller can run it as a normal turn.
 */
export function processCommand(raw: string, ctx: CommandContext): CommandResult {
  const text = raw.trim();
  if (!text.startsWith("/")) return { type: "not-command" };

  const space = text.indexOf(" ");
  const name = (space === -1 ? text : text.slice(0, space)).toLowerCase();
  const arg = space === -1 ? "" : text.slice(space + 1).trim();

  switch (name) {
    case "/exit":
    case "/quit":
      return { type: "exit" };
    case "/clear":
      return { type: "clear" };
    case "/new":
      return { type: "new" };
    case "/sessions":
      return { type: "focus-sessions" };
    case "/skills":
      return handleSkills(arg);
    case "/skill":
      return handleSkill(arg);
    case "/checkpoints":
    case "/checkpoint":
      return { type: "checkpoints" };
    case "/restore":
    case "/undo":
      return { type: "restore", id: arg || undefined };
    case "/help":
      return { type: "info", message: `${KEYBOARD_HINTS}\n${HELP_LINES.join("\n")}` };
    case "/mode":
      return handleMode(arg, ctx);
    case "/model":
      return handleModel(arg, ctx);
    case "/providers":
    case "/provider":
      return handleProviders(arg, ctx);
    case "/settings":
    case "/setting":
      return handleSettings(arg, ctx);
    case "/mcp":
      return { type: "open-mcp" };
    case "/panels":
    case "/panel":
      return handlePanels(arg);
    default:
      return { type: "error", message: `unknown command ${name} — try /help` };
  }
}
