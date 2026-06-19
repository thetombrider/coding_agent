import {
  APPROVAL_MODE_LABELS,
  APPROVAL_MODES,
  coerceApprovalMode,
  nextApprovalMode,
  type ApprovalMode,
} from "../approval/policy.js";
import { shouldOpenProviderAuthMenu } from "../provider/auth-paths.js";
import { resolveModelOnProviderSwitch } from "../provider/picker-models.js";
import type { ProviderSummary } from "../provider/registry.js";
import type { ProviderConfigField } from "../provider/types.js";

export interface CommandContext {
  currentModel: string;
  currentMode: ApprovalMode;
  knownModels: readonly string[];
  currentProvider?: string;
  providers?: ProviderSummary[];
  /** Optional lookup injected by the TUI for configure flows. */
  providerConfigFields?: (id: string) => readonly ProviderConfigField[];
}

export type CommandResult =
  | { type: "not-command" }
  | { type: "exit" }
  | { type: "clear" }
  | { type: "new" }
  | { type: "sessions" }
  | { type: "set-model"; model: string; message: string }
  | { type: "set-mode"; mode: ApprovalMode; message: string }
  | { type: "set-provider"; provider: string; model?: string; message: string }
  | {
      type: "configure-provider";
      provider: string;
      fields: readonly ProviderConfigField[];
      activateOnComplete: boolean;
      message: string;
    }
  | { type: "start-oauth"; provider: string; message: string; activateOnComplete?: boolean }
  | { type: "clear-provider-oauth"; provider: string; message: string }
  | {
      type: "open-provider-auth";
      provider: string;
      displayName: string;
      activateOnComplete: boolean;
    }
  | { type: "info"; message: string }
  | { type: "error"; message: string };

import { clipboardHintText } from "./shortcuts.js";

/** List of `/commands` shown by `/help`. */
export const KEYBOARD_HINTS = clipboardHintText();

const HELP_LINES = [
  "/mode [normal|allow-all|plan]  cycle or set approval mode",
  "/model [id|number]            switch the model",
  "/providers [id|number]        list or switch the active LLM provider",
  "/providers configure [id]     set API keys / provider settings in ~/.orin/config.json",
  "/providers oauth [id]         authenticate or re-authenticate via OAuth",
  "/providers logout [id]        clear saved OAuth tokens for a provider",
  "/sessions                     browse and resume saved sessions",
  "/new                          archive this session and start a new one",
  "/clear                        clear the conversation",
  "/help                         show this help",
  "/exit                         quit",
];

function modeInfo(ctx: CommandContext): string {
  const opts = APPROVAL_MODES.map(
    (m) => `${APPROVAL_MODE_LABELS[m]}${m === ctx.currentMode ? " (current)" : ""}`,
  ).join(" · ");
  return `mode: ${opts} — /mode <name> or /mode to cycle`;
}

function modelInfo(ctx: CommandContext): string {
  const lines = ctx.knownModels.map((m, i) => {
    const marker = m === ctx.currentModel ? " ←" : "";
    return `${i + 1}. ${m}${marker}`;
  });
  return `model: ${ctx.currentModel}\n${lines.join("\n")}\n/model <number|id> to switch`;
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

function authLabel(strategy: ProviderSummary["authStrategy"]): string {
  if (strategy === "oauth") return " [oauth]";
  if (strategy === "api-key-or-oauth") return " [api-key|oauth]";
  return "";
}

function providerInfo(ctx: CommandContext): string {
  const providers = ctx.providers ?? [];
  if (!providers.length) return "no providers registered";
  const lines = providers.map((p, i) => {
    const marker = p.active ? " ←" : "";
    const auth = authLabel(p.authStrategy);
    const status = p.configured ? "" : "  (needs setup)";
    return `${i + 1}. ${p.id}${auth}${status}${marker}`;
  });
  return `provider: ${ctx.currentProvider ?? "?"}\n${lines.join("\n")}\n/providers <number|id> to switch · /providers configure <id> · /providers oauth <id> · /providers logout <id>`;
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
  const env = field.envVar ? ` (or set ${field.envVar})` : "";
  return `enter ${field.label}${env}`;
}

function handleProviderConfigure(arg: string, ctx: CommandContext): CommandResult {
  const providers = ctx.providers ?? [];
  if (!providers.length) {
    return { type: "error", message: "no providers registered" };
  }

  if (!arg) {
    const lines = providers.map((p, i) => {
      const auth = authLabel(p.authStrategy);
      const status = p.configured ? "" : "  (needs setup)";
      return `${i + 1}. ${p.id}${auth}${status}`;
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

  if (resolved.authStrategy === "oauth") {
    return {
      type: "info",
      message: `${resolved.id} uses OAuth only — run /providers oauth ${resolved.id}`,
    };
  }

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
    message:
      `Configure ${resolved.displayName}: ${configureFieldHint(fields)}`
      + (resolved.authStrategy === "api-key-or-oauth" ? ` · or /providers oauth ${resolved.id}` : "")
      + " · Esc to cancel",
  };
}

function handleProviderLogout(arg: string, ctx: CommandContext): CommandResult {
  const providers = ctx.providers ?? [];
  if (!providers.length) {
    return { type: "error", message: "no providers registered" };
  }

  if (!arg) {
    const oauthProviders = providers.filter(
      (p) => p.authStrategy === "oauth" || p.authStrategy === "api-key-or-oauth",
    );
    if (!oauthProviders.length) {
      return { type: "info", message: "no OAuth-capable providers registered" };
    }
    const lines = oauthProviders.map((p, i) => `${i + 1}. ${p.id}`);
    return {
      type: "info",
      message: `Clear OAuth tokens for:\n${lines.join("\n")}\n/providers logout <number|id>`,
    };
  }

  const resolved = resolveProviderTarget(arg, providers);
  if ("error" in resolved) {
    return { type: "error", message: `${resolved.error}. ${providerInfo(ctx)}` };
  }

  if (resolved.authStrategy !== "oauth" && resolved.authStrategy !== "api-key-or-oauth") {
    return {
      type: "error",
      message: `${resolved.id} does not use OAuth — nothing to clear`,
    };
  }

  return {
    type: "clear-provider-oauth",
    provider: resolved.id,
    message: `Cleared OAuth tokens for ${resolved.displayName} — run /providers oauth ${resolved.id} to sign in again`,
  };
}

function handleProviderOAuth(arg: string, ctx: CommandContext): CommandResult {
  const providers = ctx.providers ?? [];
  if (!providers.length) {
    return { type: "error", message: "no providers registered" };
  }

  if (!arg) {
    const oauthProviders = providers.filter(
      (p) => p.authStrategy === "oauth" || p.authStrategy === "api-key-or-oauth",
    );
    if (!oauthProviders.length) {
      return { type: "info", message: "no OAuth-capable providers registered" };
    }
    const lines = oauthProviders.map((p, i) => `${i + 1}. ${p.id}`);
    return {
      type: "info",
      message: `OAuth providers:\n${lines.join("\n")}\n/providers oauth <number|id>`,
    };
  }

  const resolved = resolveProviderTarget(arg, providers);
  if ("error" in resolved) {
    return { type: "error", message: `${resolved.error}. ${providerInfo(ctx)}` };
  }

  if (resolved.authStrategy !== "oauth" && resolved.authStrategy !== "api-key-or-oauth") {
    return {
      type: "error",
      message: `${resolved.id} does not support OAuth — use /providers configure ${resolved.id}`,
    };
  }

  return {
    type: "start-oauth",
    provider: resolved.id,
    activateOnComplete: false,
    message: `Starting OAuth for ${resolved.displayName} — confirm policy note, then sign in (replaces saved tokens) · Esc to cancel`,
  };
}

function openProviderAuthResult(
  match: ProviderSummary,
  activateOnComplete: boolean,
): CommandResult {
  return {
    type: "open-provider-auth",
    provider: match.id,
    displayName: match.displayName,
    activateOnComplete,
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
    if (match.authStrategy === "api-key-or-oauth") {
      return openProviderAuthResult(match, false);
    }
    return { type: "info", message: `already using ${match.id}` };
  }
  if (shouldOpenProviderAuthMenu(match)) {
    return openProviderAuthResult(match, true);
  }
  const warn = match.configured
    ? ""
    : match.authStrategy === "oauth" || match.authStrategy === "api-key-or-oauth"
      ? " (not configured — run /providers oauth " + match.id + " or /providers configure " + match.id + ")"
      : " (not configured — run /providers configure " + match.id + ")";
  let message = `provider → ${match.id}${warn}`;
  const fromProvider = ctx.currentProvider ?? "openrouter";
  const { model, note } = resolveModelOnProviderSwitch(fromProvider, match.id, ctx.currentModel);
  message += note;
  return { type: "set-provider", provider: match.id, model, message };
}

function handleProviders(arg: string, ctx: CommandContext): CommandResult {
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();
  if (sub === "configure" || sub === "config") {
    return handleProviderConfigure(parts.slice(1).join(" "), ctx);
  }
  if (sub === "oauth" || sub === "reauth") {
    return handleProviderOAuth(parts.slice(1).join(" "), ctx);
  }
  if (sub === "logout") {
    return handleProviderLogout(parts.slice(1).join(" "), ctx);
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
    case "sessions":
    case "set-model":
    case "set-mode":
    case "set-provider":
    case "configure-provider":
    case "start-oauth":
    case "clear-provider-oauth":
    case "open-provider-auth":
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
      return { type: "sessions" };
    case "/help":
      return { type: "info", message: `${KEYBOARD_HINTS}\n${HELP_LINES.join("\n")}` };
    case "/mode":
      return handleMode(arg, ctx);
    case "/model":
      return handleModel(arg, ctx);
    case "/providers":
    case "/provider":
      return handleProviders(arg, ctx);
    default:
      return { type: "error", message: `unknown command ${name} — try /help` };
  }
}
