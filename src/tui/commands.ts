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
import { hasE2BApiKey } from "../config/config.js";
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
  | { type: "sessions" }
  | { type: "checkpoints" }
  | { type: "restore"; id?: string }
  | { type: "set-model"; model: string; message: string }
  | { type: "set-mode"; mode: ApprovalMode; message: string }
  | { type: "set-isolation"; isolation: IsolationMode; message: string }
  | { type: "set-provider"; provider: string; model?: string; message: string }
  | {
      type: "configure-provider";
      provider: string;
      fields: readonly ProviderConfigField[];
      activateOnComplete: boolean;
      message: string;
    }
  | { type: "configure-e2b"; message: string }
  | { type: "open-settings" }
  | { type: "info"; message: string }
  | { type: "error"; message: string };

import { clipboardHintText } from "./shortcuts.js";
import { formatModelPricingLabel } from "./views.js";

/** List of `/commands` shown by `/help`. */
export const KEYBOARD_HINTS = clipboardHintText();

const HELP_LINES = [
  "/mode [normal|allow-all|plan]  cycle or set approval mode",
  "/model [id|number]            switch the model",
  "/providers [id|number]        list or switch the active LLM provider",
  "/providers configure [id]     set API keys / provider settings in ~/.orin/config.json",
  "/settings                     open settings (E2B key, isolation, task models)",
  "/settings isolation [mode]    set subagent isolation floor (shared|worktree|sandbox)",
  "/settings e2b                 configure E2B API key (for sandbox isolation)",
  "/sessions                     browse and resume saved sessions",
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

function isolationInfo(ctx: CommandContext): string {
  const current = ctx.currentIsolation ?? "shared";
  const options = ISOLATION_MODES.map((m) => `  ${m === current ? "›" : " "} ${ISOLATION_LABELS[m]}`);
  return (
    `subagent isolation: ${current} (floor — the model may escalate, never weaken)\n`
    + `${options.join("\n")}\n`
    + "/settings isolation <shared|worktree|sandbox> to change"
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

function handleSettings(arg: string, ctx: CommandContext): CommandResult {
  const parts = arg.trim().split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();

  if (!sub) {
    return { type: "open-settings" };
  }

  if (sub === "isolation") {
    return handleIsolation(parts[1], ctx);
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

  return { type: "error", message: `unknown setting "${sub}" — try /settings isolation or /settings e2b` };
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
    case "sessions":
    case "checkpoints":
    case "restore":
    case "set-model":
    case "set-mode":
    case "set-isolation":
    case "set-provider":
    case "configure-provider":
      return true;
    case "configure-e2b":
      return true;
    case "open-settings":
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
    default:
      return { type: "error", message: `unknown command ${name} — try /help` };
  }
}
