import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isToolBlocked,
  matchesAutoApprovedCommand,
  needsInteractiveApproval,
  shouldAutoAccept,
} from "./policy.js";

describe("approval policy", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-approval-test-"));
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("parses approval mode from config", async () => {
    const { saveConfig } = await import("../config/config.js");
    saveConfig({ approval: { mode: "plan" } });
    vi.resetModules();
    const { parseApprovalMode } = await import("./policy.js");
    expect(parseApprovalMode()).toBe("plan");
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
