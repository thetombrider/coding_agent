import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLocalWorkspace } from "./local.js";
import type { Workspace } from "./types.js";
import type { AgentContext, LoopHost } from "../types.js";

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

export type HarvestResult =
  | { branch: string; committed: boolean; diffStat: string }
  | { branch: string; error: string };

export interface WorktreeHandle {
  /** A local workspace; tools resolve paths against `cwd` (the worktree dir). */
  workspace: Workspace;
  cwd: string;
  branch: string;
  /** Host repo root the worktree was created from. */
  hostCwd: string;
  /**
   * Commit any work left in the worktree onto its branch so it survives worktree
   * removal, and return a `git diff --stat` of the branch versus its base commit.
   * Identity is supplied inline so it works without global git config. Returns an
   * `error` result (without removing anything) if the commit fails, so the caller
   * can keep the worktree for recovery rather than discard uncommitted edits.
   */
  harvest(): HarvestResult;
  /** Remove the worktree dir. The branch (and any harvested commit) is retained. */
  remove(): void;
}

export type CreateWorktreeResult = { handle: WorktreeHandle } | { error: string };

export interface CreateWorktreeOptions {
  /** Branch name prefix, e.g. `orin/subagent` or `orin/session`. Default: `orin/subagent`. */
  branchPrefix?: string;
  /** Commit message subject, e.g. `subagent` or `session`. Default: `subagent`. */
  commitLabel?: string;
  /** Use a fixed directory instead of a temp dir under `tmpdir()`. */
  dir?: string;
  /** Attach to an existing branch instead of creating a new one. */
  existingBranch?: string;
  /**
   * Commit or branch to branch from when creating a fresh worktree. Defaults to
   * `HEAD` at `hostCwd`. Use the session branch tip when the parent session runs
   * in worktree mode so subagent branches include prior session work.
   */
  baseRef?: string;
}

function buildHandle(
  hostCwd: string,
  dir: string,
  branch: string,
  baseSha: string,
  shortId: string,
  commitLabel: string,
  ownsTempBase: boolean,
): WorktreeHandle {
  return {
    workspace: createLocalWorkspace(),
    cwd: dir,
    branch,
    hostCwd,
    harvest() {
      git(dir, ["add", "-A"]);
      const hasChanges = git(dir, ["diff", "--cached", "--quiet"]).status !== 0;
      let committed = false;
      if (hasChanges) {
        const commit = git(dir, [
          "-c", "user.name=orin",
          "-c", "user.email=orin@localhost",
          "commit", "-m", `${commitLabel} ${shortId} changes`,
        ]);
        if (commit.status !== 0) {
          return { branch, error: commit.stderr || commit.stdout || "git commit failed" };
        }
        committed = true;
      }
      const stat = git(hostCwd, ["diff", "--stat", `${baseSha}..${branch}`]);
      return { branch, committed, diffStat: stat.stdout };
    },
    remove() {
      git(hostCwd, ["worktree", "remove", "--force", dir]);
      if (ownsTempBase) {
        rmSync(dirname(dir), { recursive: true, force: true });
      }
    },
  };
}

/**
 * Create or attach a git worktree on a branch off the host repo's HEAD (or
 * `baseRef` / an existing branch). Edits are isolated from the host working tree
 * but persist to the branch. Branches from HEAD when creating fresh, so
 * uncommitted host changes are not carried in (documented limitation). Parallel
 * subagents in session worktree mode pass `baseRef` as the session branch tip.
 */
export function createWorktree(
  hostCwd: string,
  id: string,
  opts: CreateWorktreeOptions = {},
): CreateWorktreeResult {
  const shortId = id.slice(0, 8);
  const branchPrefix = opts.branchPrefix ?? "orin/subagent";
  const commitLabel = opts.commitLabel ?? "subagent";
  const branch = opts.existingBranch ?? `${branchPrefix}-${shortId}`;

  let baseSha = "";
  if (!opts.existingBranch) {
    const base = opts.baseRef
      ? git(hostCwd, ["rev-parse", "--verify", opts.baseRef])
      : git(hostCwd, ["rev-parse", "HEAD"]);
    if (base.status !== 0) {
      return {
        error: opts.baseRef
          ? `Could not resolve base ref ${opts.baseRef}: ${base.stderr || base.stdout}`
          : "Worktree isolation requires a git repository with at least one commit. "
            + 'Use isolation "shared" (the default) or commit your work first.',
      };
    }
    baseSha = base.stdout;
  } else {
    const verify = git(hostCwd, ["rev-parse", "--verify", branch]);
    if (verify.status !== 0) {
      return { error: `branch ${branch} not found in ${hostCwd}` };
    }
    baseSha = verify.stdout;
  }

  let dir = opts.dir;
  let ownsTempBase = false;
  if (!dir) {
    const base = mkdtempSync(join(tmpdir(), `orin-wt-${shortId}-`));
    dir = join(base, "tree");
    ownsTempBase = true;
  } else {
    mkdirSync(dirname(dir), { recursive: true });
  }

  if (existsSync(dir)) {
    const listed = git(hostCwd, ["worktree", "list", "--porcelain"]);
    if (listed.stdout.includes(dir)) {
      return {
        handle: buildHandle(hostCwd, dir, branch, baseSha, shortId, commitLabel, ownsTempBase),
      };
    }
  }

  const addArgs = opts.existingBranch
    ? ["worktree", "add", dir, branch]
    : ["worktree", "add", "-b", branch, dir, baseSha];
  const add = git(hostCwd, addArgs);
  if (add.status !== 0) {
    if (ownsTempBase) rmSync(dirname(dir), { recursive: true, force: true });
    return { error: `git worktree add failed: ${add.stderr || add.stdout}` };
  }

  return {
    handle: buildHandle(hostCwd, dir, branch, baseSha, shortId, commitLabel, ownsTempBase),
  };
}

/**
 * Options for a dedicated subagent worktree (`runSubagentTask` with worktree
 * isolation). Parallel fan-out in session worktree mode branches from the session
 * tip so each orin/subagent-* child includes committed session work; host-tree
 * parallel fan-out omits baseRef and branches from host HEAD instead.
 */
export function subagentWorktreeOptions(
  host: Pick<LoopHost, "sessionIsolation" | "sessionBranch">,
  ctx: Pick<AgentContext, "cwd">,
  parallel: boolean,
): Pick<CreateWorktreeOptions, "baseRef"> {
  if (!parallel || host.sessionIsolation !== "worktree") return {};
  if (host.sessionBranch) return { baseRef: host.sessionBranch };
  const tip = git(ctx.cwd, ["rev-parse", "HEAD"]);
  if (tip.status === 0 && tip.stdout) return { baseRef: tip.stdout };
  return {};
}
