import {
  APPROVAL_MODE_LABELS,
  APPROVAL_MODES,
  coerceApprovalMode,
  nextApprovalMode,
  type ApprovalMode,
} from "../approval/policy.js";

export interface CommandContext {
  currentModel: string;
  currentMode: ApprovalMode;
  knownModels: readonly string[];
}

export type CommandResult =
  | { type: "not-command" }
  | { type: "exit" }
  | { type: "clear" }
  | { type: "set-model"; model: string; message: string }
  | { type: "set-mode"; mode: ApprovalMode; message: string }
  | { type: "info"; message: string }
  | { type: "error"; message: string };

/** List of `/commands` shown by `/help`. */
const HELP_LINES = [
  "/mode [normal|allow-all|plan]  cycle or set approval mode",
  "/model [id|number]            switch the OpenRouter model",
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
    case "/help":
      return { type: "info", message: HELP_LINES.join("\n") };
    case "/mode":
      return handleMode(arg, ctx);
    case "/model":
      return handleModel(arg, ctx);
    default:
      return { type: "error", message: `unknown command ${name} — try /help` };
  }
}
