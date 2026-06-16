import {
  APPROVAL_MODE_LABELS,
  APPROVAL_MODES,
  coerceApprovalMode,
  nextApprovalMode,
  type ApprovalMode,
} from "../approval/policy.js";
import { hasE2BApiKey } from "../config/config.js";
import type { SandboxKind } from "../workspace/types.js";

export interface CommandContext {
  currentModel: string;
  currentMode: ApprovalMode;
  currentSandbox: SandboxKind;
  knownModels: readonly string[];
}

export type CommandResult =
  | { type: "not-command" }
  | { type: "exit" }
  | { type: "clear" }
  | { type: "new" }
  | { type: "sessions" }
  | { type: "set-model"; model: string; message: string }
  | { type: "set-mode"; mode: ApprovalMode; message: string }
  | { type: "set-sandbox"; kind: SandboxKind; message: string }
  | { type: "info"; message: string }
  | { type: "error"; message: string };

/** List of `/commands` shown by `/help`. */
const HELP_LINES = [
  "/mode [normal|allow-all|plan]  cycle or set approval mode",
  "/model [id|number]            switch the OpenRouter model",
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
      return { type: "info", message: HELP_LINES.join("\n") };
    case "/mode":
      return handleMode(arg, ctx);
    case "/model":
      return handleModel(arg, ctx);
    case "/sandbox":
      return handleSandbox(arg, ctx);
    default:
      return { type: "error", message: `unknown command ${name} — try /help` };
  }
}
