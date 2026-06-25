import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapSessionWorktree, removeSessionWorktree, sessionBranchName, sessionWorktreeDir } from "./session-worktree.js";

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

describe("bootstrapSessionWorktree", () => {
  let host: string;
  const sessionId = "abcd1234efgh";
  const worktreeDir = sessionWorktreeDir(sessionId);

  beforeEach(() => {
    host = mkdtempSync(join(tmpdir(), "orin-session-host-"));
    rmSync(join(worktreeDir, ".."), { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(host, { recursive: true, force: true });
    rmSync(join(worktreeDir, ".."), { recursive: true, force: true });
    try {
      git(host, "worktree", "remove", "--force", worktreeDir);
    } catch {
      // ignore
    }
  });

  it("creates a persistent session worktree on a fresh branch", () => {
    initRepo(host);
    const result = bootstrapSessionWorktree(host, sessionId);
    expect("binding" in result).toBe(true);
    if (!("binding" in result)) return;

    expect(result.binding.branch).toBe(sessionBranchName(sessionId));
    expect(result.binding.handle.cwd).toBe(worktreeDir);
    expect(existsSync(result.binding.handle.cwd)).toBe(true);
    writeFileSync(join(result.binding.handle.cwd, "feature.txt"), "session edit\n");
    expect(existsSync(join(host, "feature.txt"))).toBe(false);
  });

  it("reattaches to an existing session branch and worktree dir", () => {
    initRepo(host);
    const first = bootstrapSessionWorktree(host, sessionId);
    if (!("binding" in first)) throw new Error("expected binding");
    writeFileSync(join(first.binding.handle.cwd, "kept.txt"), "keep me\n");
    first.binding.handle.harvest();

    const second = bootstrapSessionWorktree(host, sessionId, {
      branch: first.binding.branch,
      worktreeDir: first.binding.worktreeDir,
      hostCwd: host,
    });
    expect("binding" in second).toBe(true);
    if (!("binding" in second)) return;
    expect(readFileSync(join(second.binding.handle.cwd, "kept.txt"), "utf8")).toBe("keep me\n");
  });
});

describe("removeSessionWorktree", () => {
  let host: string;
  const sessionId = "abcd1234efgh";
  const worktreeDir = sessionWorktreeDir(sessionId);

  beforeEach(() => {
    host = mkdtempSync(join(tmpdir(), "orin-session-host-"));
    rmSync(join(worktreeDir, ".."), { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(host, { recursive: true, force: true });
    rmSync(join(worktreeDir, ".."), { recursive: true, force: true });
  });

  it("removes the worktree dir and git registration but keeps the branch", () => {
    initRepo(host);
    const boot = bootstrapSessionWorktree(host, sessionId);
    if (!("binding" in boot)) throw new Error("expected binding");
    const branch = boot.binding.branch;

    expect(
      removeSessionWorktree(sessionId, {
        hostCwd: host,
        worktreeDir,
        branch,
        isolation: "worktree",
      }),
    ).toBe(true);

    expect(existsSync(worktreeDir)).toBe(false);
    expect(git(host, "worktree", "list").includes(worktreeDir)).toBe(false);
    expect(git(host, "branch", "--list", branch).trim()).toBe(branch);
  });

  it("returns false when there is nothing to remove", () => {
    expect(removeSessionWorktree("missing-session")).toBe(false);
  });
});
