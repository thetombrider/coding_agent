import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorkspace } from "./local.js";
import type { Workspace } from "./types.js";

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
}

export interface WorktreeHandle {
  /** A local workspace; tools resolve paths against `cwd` (the worktree dir). */
  workspace: Workspace;
  cwd: string;
  branch: string;
  /**
   * Commit any work left in the worktree onto its branch so it survives worktree
   * removal, and return a `git diff --stat` of the branch versus its base commit.
   * Identity is supplied inline so it works without global git config.
   */
  harvest(): { branch: string; committed: boolean; diffStat: string };
  /** Remove the worktree dir. The branch (and any harvested commit) is retained. */
  remove(): void;
}

export type CreateWorktreeResult = { handle: WorktreeHandle } | { error: string };

/**
 * Create a git worktree on a fresh branch off the host repo's HEAD. The subagent
 * runs there, so its edits are isolated from the host working tree but persist
 * to a local branch the user can inspect and merge. Branches from HEAD, so
 * uncommitted host changes are not carried in (documented limitation).
 */
export function createWorktree(hostCwd: string, id: string): CreateWorktreeResult {
  const head = git(hostCwd, ["rev-parse", "HEAD"]);
  if (head.status !== 0) {
    return {
      error:
        "Worktree isolation requires a git repository with at least one commit. "
        + 'Use isolation "shared" (the default) or commit your work first.',
    };
  }
  const baseSha = head.stdout;
  const shortId = id.slice(0, 8);
  const branch = `orin/subagent-${shortId}`;
  const base = mkdtempSync(join(tmpdir(), `orin-wt-${shortId}-`));
  const dir = join(base, "tree");

  const add = git(hostCwd, ["worktree", "add", "-b", branch, dir, baseSha]);
  if (add.status !== 0) {
    rmSync(base, { recursive: true, force: true });
    return { error: `git worktree add failed: ${add.stderr || add.stdout}` };
  }

  return {
    handle: {
      workspace: createLocalWorkspace(),
      cwd: dir,
      branch,
      harvest() {
        git(dir, ["add", "-A"]);
        // `diff --cached --quiet` exits non-zero when there are staged changes.
        const hasChanges = git(dir, ["diff", "--cached", "--quiet"]).status !== 0;
        let committed = false;
        if (hasChanges) {
          const commit = git(dir, [
            "-c", "user.name=orin",
            "-c", "user.email=orin@localhost",
            "commit", "-m", `subagent ${shortId} changes`,
          ]);
          committed = commit.status === 0;
        }
        const stat = git(hostCwd, ["diff", "--stat", `${baseSha}..${branch}`]);
        return { branch, committed, diffStat: stat.stdout };
      },
      remove() {
        git(hostCwd, ["worktree", "remove", "--force", dir]);
        rmSync(base, { recursive: true, force: true });
      },
    },
  };
}
