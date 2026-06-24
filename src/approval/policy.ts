import { loadConfig } from "../config/config.js";

export type ApprovalMode = "normal" | "auto-accept" | "plan";

const WRITE_TOOLS = new Set(["write", "edit", "bash", "file_op"]);

/** Cycle order for `/mode` with no argument. */
export const APPROVAL_MODES: readonly ApprovalMode[] = ["normal", "auto-accept", "plan"];

/** Human-friendly label shown to the user (the user calls auto-accept "allow all"). */
export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  normal: "normal",
  "auto-accept": "allow all",
  plan: "plan",
};

/** Resolve a user-typed mode name (and common aliases) to an ApprovalMode, or null. */
export function coerceApprovalMode(raw: string): ApprovalMode | null {
  const v = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (v === "normal" || v === "default") return "normal";
  if (v === "auto-accept" || v === "auto" || v === "allow-all" || v === "allowall") {
    return "auto-accept";
  }
  if (v === "plan" || v === "planning") return "plan";
  return null;
}

/** Next mode in the cycle, wrapping around. */
export function nextApprovalMode(mode: ApprovalMode): ApprovalMode {
  const idx = APPROVAL_MODES.indexOf(mode);
  return APPROVAL_MODES[(idx + 1) % APPROVAL_MODES.length]!;
}

export function parseApprovalMode(): ApprovalMode {
  return loadConfig().approval.mode;
}

export function shouldAutoAccept(mode: ApprovalMode, cliFlag: boolean): boolean {
  return cliFlag || mode === "auto-accept";
}

/** True when a bash command matches a configured auto-approval prefix or exact entry. */
export function matchesAutoApprovedCommand(
  command: string,
  patterns: readonly string[],
): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  return patterns.some((pattern) => {
    const p = pattern.trim();
    if (!p) return false;
    if (cmd === p) return true;
    return cmd.startsWith(`${p} `);
  });
}

export function isAutoApprovedBash(name: string, args: unknown): boolean {
  if (name !== "bash") return false;
  const command = (args as { command?: string }).command;
  if (typeof command !== "string") return false;
  return matchesAutoApprovedCommand(command, loadConfig().approval.autoApprovedCommands);
}

export function isToolBlocked(mode: ApprovalMode, toolName: string): boolean {
  return mode === "plan" && WRITE_TOOLS.has(toolName);
}

export function needsInteractiveApproval(
  mode: ApprovalMode,
  autoAcceptCli: boolean,
  toolName: string,
  toolNeedsApproval?: boolean,
  autoApproved = false,
): boolean {
  if (shouldAutoAccept(mode, autoAcceptCli)) return false;
  if (isToolBlocked(mode, toolName)) return true;
  if (autoApproved) return false;
  return toolNeedsApproval === true;
}
