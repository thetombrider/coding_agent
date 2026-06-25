import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { SessionIsolationMode } from "../agent/session-isolation.js";
import type { SessionMetaRecord } from "../session/log.js";
import { createWorktree, type WorktreeHandle } from "./worktree.js";

function git(cwd: string, args: string[]): { status: number; stderr: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return { status: r.status ?? 1, stderr: (r.stderr ?? "").trim() };
}

export interface SessionWorktreeBinding {
  hostCwd: string;
  worktreeDir: string;
  branch: string;
  handle: WorktreeHandle;
}

export function sessionWorktreeDir(sessionId: string): string {
  return join(sessionWorktreeRoot(sessionId), "tree");
}

export function sessionWorktreeRoot(sessionId: string): string {
  return join(homedir(), ".orin", "worktrees", sessionId);
}

export function sessionBranchName(sessionId: string): string {
  return `orin/session-${sessionId.slice(0, 8)}`;
}

/**
 * Bootstrap a session worktree: attach to an existing branch/dir when resuming or
 * reusing an empty session, otherwise create a fresh branch under `orin/session-*`.
 */
export function bootstrapSessionWorktree(
  hostCwd: string,
  sessionId: string,
  meta?: Pick<SessionMetaRecord, "branch" | "worktreeDir" | "hostCwd">,
): { binding: SessionWorktreeBinding } | { error: string } {
  const worktreeDir = meta?.worktreeDir ?? sessionWorktreeDir(sessionId);
  const branch = meta?.branch ?? sessionBranchName(sessionId);
  mkdirSync(join(worktreeDir, ".."), { recursive: true });

  const attachExisting = Boolean(meta?.branch) || existsSync(worktreeDir);
  const result = createWorktree(hostCwd, sessionId, {
    branchPrefix: "orin/session",
    commitLabel: "session",
    dir: worktreeDir,
    existingBranch: attachExisting ? branch : undefined,
  });

  if ("error" in result) return result;

  return {
    binding: {
      hostCwd,
      worktreeDir: result.handle.cwd,
      branch: result.handle.branch,
      handle: result.handle,
    },
  };
}

export function resolveSessionIsolation(
  configMode: SessionIsolationMode | undefined,
  cliWorktree: boolean,
): SessionIsolationMode {
  if (cliWorktree) return "worktree";
  return configMode ?? "shared";
}

/**
 * Tear down a session's git worktree and local storage. Reads `hostCwd` /
 * `worktreeDir` from session meta when present. The session branch is retained
 * (same as subagent worktrees) so work can still be inspected or merged. No-op
 * when nothing exists.
 */
export function removeSessionWorktree(
  sessionId: string,
  meta?: Pick<SessionMetaRecord, "hostCwd" | "worktreeDir" | "branch" | "isolation">,
): boolean {
  const worktreeDir = meta?.worktreeDir ?? sessionWorktreeDir(sessionId);
  const sessionRoot = dirname(worktreeDir);
  const hostCwd = meta?.hostCwd;

  const hadWorktree =
    meta?.isolation === "worktree"
    || existsSync(worktreeDir)
    || existsSync(sessionRoot);

  if (!hadWorktree) return false;

  if (hostCwd && existsSync(worktreeDir)) {
    git(hostCwd, ["worktree", "remove", "--force", worktreeDir]);
  }

  if (existsSync(sessionRoot)) {
    rmSync(sessionRoot, { recursive: true, force: true });
  }

  return true;
}
