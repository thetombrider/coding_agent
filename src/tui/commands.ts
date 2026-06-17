import {
  APPROVAL_MODE_LABELS,
  APPROVAL_MODES,
  coerceApprovalMode,
  nextApprovalMode,
  type ApprovalMode,
} from "../approval/policy.js";
import { hasE2BApiKey } from "../config/config.js";
import type { ProviderSummary } from "../provider/registry.js";
import type { ProviderConfigField } from "../provider/types.js";
import type { SandboxKind } from "../workspace/types.js";

export interface CommandContext {
  currentModel: string;
  currentMode: ApprovalMode;
  currentSandbox: SandboxKind;
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
  | { type: "set-provider"; provider: string; message: string }
  | {
      type: "configure-provider";
      provider: string;
      fields: readonly ProviderConfigField[];
      activateOnComplete: boolean;
      message: string;
    }
  | { type: "set-sandbox"; kind: SandboxKind; message: string }
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
  "/sandbox [local|e2b]          run tools locally or in an E2B cloud sandbox",
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

function providerInfo(ctx: CommandContext): string {
  const providers = ctx.providers ?? [];
  if (!providers.length) return "no providers registered";
  const lines = providers.map((p, i) => {
    const marker = p.active ? " ←" : "";
    const auth = p.authStrategy === "oauth" ? " [oauth]" : "";
    const status = p.configured ? "" : "  (needs setup)";
    return `${i + 1}. ${p.id}${auth}${status}${marker}`;
  });
  return `provider: ${ctx.currentProvider ?? "?"}\n${lines.join("\n")}\n/providers <number|id> to switch · /providers configure <id> to set up`;
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
      const auth = p.authStrategy === "oauth" ? " [oauth]" : "";
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
      message: `${resolved.id} uses OAuth — loopback auth is not available in the TUI yet. Complete OAuth setup when that provider is implemented.`,
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
    : match.authStrategy === "oauth"
      ? " (not configured — complete its OAuth setup)"
      : " (not configured — run /providers configure " + match.id + ")";
  let message = `provider → ${match.id}${warn}`;
  if (match.id === "regolo" && ctx.currentModel.includes("/")) {
    message +=
      " — switch model with /model (Regolo uses native ids like Llama-3.3-70B-Instruct)";
  }
  return { type: "set-provider", provider: match.id, message };
}

function handleProviders(arg: string, ctx: CommandContext): CommandResult {
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();
  if (sub === "configure" || sub === "config") {
    return handleProviderConfigure(parts.slice(1).join(" "), ctx);
  }
  return handleProviderSwitch(arg, ctx);
}

const SANDBOX_KINDS: SandboxKind[] = ["local", "e2b"];

function sandboxInfo(ctx: CommandContext): string {
  const opts = SANDBOX_KINDS.map(
    (k) => `${k}${k === ctx.currentSandbox ? " (current)" : ""}`,
  ).join(" · ");
  return `sandbox: ${opts} — /sandbox <kind> or /sandbox to cycle`;
}

function nextSandboxKind(current: SandboxKind): SandboxKind {
  const idx = SANDBOX_KINDS.indexOf(current);
  for (let step = 1; step <= SANDBOX_KINDS.length; step++) {
    const next = SANDBOX_KINDS[(idx + step) % SANDBOX_KINDS.length] ?? "local";
    if (next === "e2b" && !hasE2BApiKey()) continue;
    return next;
  }
  return "local";
}

function handleSandbox(arg: string, ctx: CommandContext): CommandResult {
  const kind = (arg || nextSandboxKind(ctx.currentSandbox)) as SandboxKind;
  if (!SANDBOX_KINDS.includes(kind)) {
    return { type: "error", message: `unknown sandbox "${arg}". ${sandboxInfo(ctx)}` };
  }
  if (kind === "e2b" && !hasE2BApiKey()) {
    return {
      type: "error",
      message: "E2B_API_KEY is not set. Add it to your environment or ~/.orin/config.json (sandbox.e2b.apiKey).",
    };
  }
  if (kind === ctx.currentSandbox) {
    return { type: "info", message: `already using ${kind} sandbox` };
  }
  return { type: "set-sandbox", kind, message: `sandbox → ${kind}` };
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
    case "/sandbox":
      return handleSandbox(arg, ctx);
    default:
      return { type: "error", message: `unknown command ${name} — try /help` };
  }
}
