import { describe, expect, it } from "vitest";
import {
  effectiveSerialSubagentMenuValue,
  parentWorkspaceMenuValue,
  workspaceSettingsOverview,
} from "./workspace-settings.js";

describe("workspace settings labels", () => {
  it("shows session-branch effective serial behavior", () => {
    expect(effectiveSerialSubagentMenuValue("worktree", "shared")).toBe("co-edit session branch");
    expect(effectiveSerialSubagentMenuValue("worktree", "worktree")).toMatch(/floor worktree on host tree/);
  });

  it("shows floor when parent uses the host tree", () => {
    expect(effectiveSerialSubagentMenuValue("shared", "worktree")).toBe("floor: worktree");
  });

  it("summarizes parent workspace from branch or cwd", () => {
    expect(parentWorkspaceMenuValue("worktree", "orin/session-abc", "/repo")).toBe(
      "session branch · orin/session-abc",
    );
    expect(parentWorkspaceMenuValue("shared", undefined, "/Users/me/proj")).toContain("host tree ·");
  });

  it("builds a workspace overview block", () => {
    const text = workspaceSettingsOverview({
      sessionIsolation: "worktree",
      sessionBranch: "orin/session-deadbeef",
      cwd: "/repo/wt",
      subagentFloor: "shared",
    });
    expect(text).toContain("serial task:");
    expect(text).toContain("co-edit session branch");
    expect(text).toContain("worktree per child");
  });
});
