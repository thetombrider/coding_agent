export type ApprovalMode = "normal" | "auto-accept" | "plan";

const WRITE_TOOLS = new Set(["write", "edit", "bash"]);

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
  const raw = process.env.MINICODER_APPROVAL_MODE?.trim().toLowerCase();
  if (raw === "auto-accept" || raw === "auto") return "auto-accept";
  if (raw === "plan") return "plan";
  return "normal";
}

export function shouldAutoAccept(mode: ApprovalMode, cliFlag: boolean): boolean {
  return cliFlag || mode === "auto-accept";
}

export function isToolBlocked(mode: ApprovalMode, toolName: string): boolean {
  return mode === "plan" && WRITE_TOOLS.has(toolName);
}

export function needsInteractiveApproval(
  mode: ApprovalMode,
  autoAcceptCli: boolean,
  toolName: string,
  toolNeedsApproval?: boolean,
): boolean {
  if (shouldAutoAccept(mode, autoAcceptCli)) return false;
  if (isToolBlocked(mode, toolName)) return true;
  return toolNeedsApproval === true;
}
