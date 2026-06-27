import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree, subagentWorktreeOptions } from "./worktree.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function initRepo(dir: string): void {
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@localhost");
  writeFileSync(join(dir, "seed.txt"), "base\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
}

describe("createWorktree", () => {
  let host: string;

  beforeEach(() => {
    host = mkdtempSync(join(tmpdir(), "orin-wt-host-"));
  });

  afterEach(() => {
    rmSync(host, { recursive: true, force: true });
  });

  it("errors when the host is not a git repo with a commit", () => {
    const result = createWorktree(host, "abcdef12");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/requires a git repository/);
  });

  it("creates a worktree on a fresh branch off HEAD", () => {
    initRepo(host);
    const result = createWorktree(host, "abcdef1234", {
      branchPrefix: "orin/subagent",
      commitLabel: "subagent",
    });
    expect("handle" in result).toBe(true);
    if (!("handle" in result)) return;

    const { handle } = result;
    try {
      expect(handle.branch).toBe("orin/subagent-abcdef12");
      expect(existsSync(handle.cwd)).toBe(true);
      // The worktree starts from the base commit's content.
      expect(readFileSync(join(handle.cwd, "seed.txt"), "utf8")).toBe("base\n");
    } finally {
      handle.remove();
    }
  });

  it("branches from baseRef instead of host HEAD", () => {
    initRepo(host);
    git(host, "checkout", "-q", "-b", "orin/session-test");
    writeFileSync(join(host, "session.txt"), "session-only\n");
    git(host, "add", "-A");
    git(host, "commit", "-q", "-m", "session work");
    git(host, "checkout", "-q", "-");

    const result = createWorktree(host, "session001", { baseRef: "orin/session-test" });
    if (!("handle" in result)) throw new Error("expected handle");
    const { handle } = result;

    try {
      expect(readFileSync(join(handle.cwd, "session.txt"), "utf8")).toBe("session-only\n");
      expect(existsSync(join(host, "session.txt"))).toBe(false);
    } finally {
      handle.remove();
    }
  });

  it("isolates worktree edits from the host working tree", () => {
    initRepo(host);
    const result = createWorktree(host, "deadbeef00");
    if (!("handle" in result)) throw new Error("expected handle");
    const { handle } = result;

    try {
      writeFileSync(join(handle.cwd, "new.txt"), "from subagent\n");
      // Host working tree is untouched until harvest/merge.
      expect(existsSync(join(host, "new.txt"))).toBe(false);
    } finally {
      handle.remove();
    }
  });

  it("harvest commits worktree changes and reports a diff stat", () => {
    initRepo(host);
    const result = createWorktree(host, "cafe000011");
    if (!("handle" in result)) throw new Error("expected handle");
    const { handle } = result;

    try {
      writeFileSync(join(handle.cwd, "feature.txt"), "hello\n");
      const harvest = handle.harvest();

      expect("error" in harvest).toBe(false);
      if ("error" in harvest) return;
      expect(harvest.committed).toBe(true);
      expect(harvest.diffStat).toMatch(/feature\.txt/);

      // The commit lives on the branch and survives worktree removal.
      const log = git(host, "log", "--oneline", handle.branch);
      expect(log).toMatch(/subagent cafe0000 changes/);
    } finally {
      handle.remove();
    }
  });

  it("harvest reports committed:false when there are no changes", () => {
    initRepo(host);
    const result = createWorktree(host, "0badc0de00");
    if (!("handle" in result)) throw new Error("expected handle");
    const { handle } = result;

    try {
      const harvest = handle.harvest();
      expect("error" in harvest).toBe(false);
      if ("error" in harvest) return;
      expect(harvest.committed).toBe(false);
    } finally {
      handle.remove();
    }
  });

  it("remove deletes the worktree directory but keeps the branch", () => {
    initRepo(host);
    const result = createWorktree(host, "11112222aa");
    if (!("handle" in result)) throw new Error("expected handle");
    const { handle } = result;

    writeFileSync(join(handle.cwd, "x.txt"), "x\n");
    handle.harvest();
    handle.remove();

    expect(existsSync(handle.cwd)).toBe(false);
    // Branch still resolves after the worktree is gone.
    expect(git(host, "rev-parse", "--verify", handle.branch)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("subagentWorktreeOptions uses the session branch when the parent runs in worktree mode", () => {
    initRepo(host);
    expect(subagentWorktreeOptions({ sessionIsolation: "shared" }, { cwd: host }, true)).toEqual({});
    expect(subagentWorktreeOptions({ sessionIsolation: "worktree", sessionBranch: "orin/session-abc" }, { cwd: host }, false)).toEqual({});
    expect(
      subagentWorktreeOptions(
        { sessionIsolation: "worktree", sessionBranch: "orin/session-abc" },
        { cwd: host },
        true,
      ),
    ).toEqual({ baseRef: "orin/session-abc" });
  });
});
