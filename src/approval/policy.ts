export type ApprovalMode = "normal" | "auto-accept" | "plan";

const WRITE_TOOLS = new Set(["write", "edit", "bash"]);

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
