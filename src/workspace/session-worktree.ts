import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionIsolationMode } from "../agent/session-isolation.js";
import type { SessionMetaRecord } from "../session/log.js";
import { createWorktree, type WorktreeHandle } from "./worktree.js";

export interface SessionWorktreeBinding {
  hostCwd: string;
  worktreeDir: string;
  branch: string;
  handle: WorktreeHandle;
}

export function sessionWorktreeDir(sessionId: string): string {
  return join(homedir(), ".orin", "worktrees", sessionId, "tree");
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
