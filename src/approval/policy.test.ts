import { describe, expect, it } from "vitest";
import {
  isToolBlocked,
  matchesAutoApprovedCommand,
  needsInteractiveApproval,
  parseApprovalMode,
  shouldAutoAccept,
} from "./policy.js";

describe("approval policy", () => {
  it("parses approval mode from env", () => {
    const prev = process.env.ORIN_APPROVAL_MODE;
    process.env.ORIN_APPROVAL_MODE = "plan";
    expect(parseApprovalMode()).toBe("plan");
    process.env.ORIN_APPROVAL_MODE = prev;
  });

  it("blocks write tools in plan mode", () => {
    expect(isToolBlocked("plan", "write")).toBe(true);
    expect(isToolBlocked("plan", "read")).toBe(false);
  });

  it("skips approval in auto-accept mode", () => {
    expect(shouldAutoAccept("auto-accept", false)).toBe(true);
    expect(needsInteractiveApproval("auto-accept", false, "bash", true)).toBe(false);
  });

  it("requires approval in normal mode for gated tools", () => {
    expect(needsInteractiveApproval("normal", false, "bash", true)).toBe(true);
    expect(needsInteractiveApproval("normal", false, "read", false)).toBe(false);
  });

  it("matches exact and prefix auto-approved bash commands", () => {
    const patterns = ["git status", "ls"];
    expect(matchesAutoApprovedCommand("git status", patterns)).toBe(true);
    expect(matchesAutoApprovedCommand("git status --short", patterns)).toBe(true);
    expect(matchesAutoApprovedCommand("ls -la", patterns)).toBe(true);
    expect(matchesAutoApprovedCommand("git diff", patterns)).toBe(false);
  });

  it("skips approval when bash command is auto-approved", () => {
    expect(needsInteractiveApproval("normal", false, "bash", true, true)).toBe(false);
    expect(needsInteractiveApproval("normal", false, "write", true, false)).toBe(true);
  });
});
