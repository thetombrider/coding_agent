import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root dir holding one shadow git repo per session. */
export function checkpointsDir(): string {
  return join(homedir(), ".orin", "checkpoints");
}

/** The shadow git dir for a session (separate from the project's real `.git`). */
export function checkpointGitDir(sessionId: string): string {
  return join(checkpointsDir(), sessionId);
}

/** Tools whose effects we snapshot. `bash` only yields a checkpoint when it
 * actually changed the tree — a no-op commit is never created (see {@link snapshot}). */
const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name);
}

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface SnapshotResult {
  /** Short SHA of the new (or, when nothing changed, existing) HEAD commit. */
  id: string;
  /** True when a new commit was created; false when the tree was unchanged. */
  created: boolean;
}

export interface CheckpointEntry {
  id: string;
  label: string;
  ts: string;
}

export interface CheckpointTracker {
  readonly gitDir: string;
  readonly workTree: string;
  /** Snapshot the work tree. No commit is made when nothing changed unless
   * `allowEmpty` is set (used for the session baseline). Returns `null` when there
   * was nothing to record and `allowEmpty` was false. */
  snapshot(label: string, allowEmpty?: boolean): SnapshotResult | null;
  /** Hard-reset the work tree to a checkpoint and remove files added since, while
   * leaving `.gitignore`d files untouched. */
  restore(id: string): { ok: boolean; message: string };
  /** Newest-first list of checkpoints from the shadow repo's history. */
  list(): CheckpointEntry[];
}

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function runGit(gitDir: string, workTree: string, args: string[]): GitResult {
  const r = spawnSync(
    "git",
    [
      `--git-dir=${gitDir}`,
      `--work-tree=${workTree}`,
      // Keep the shadow repo hermetic: never fire the user's git hooks, and supply
      // an inline identity so commits work without global git config.
      "-c", "core.hooksPath=/dev/null",
      "-c", "commit.gpgsign=false",
      "-c", "user.name=orin",
      "-c", "user.email=orin@localhost",
      ...args,
    ],
    { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER },
  );
  return {
    status: r.status ?? 1,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
}

/**
 * A checkpoint tracker backed by a shadow git repo. The git dir lives outside the
 * work tree (under `~/.orin/checkpoints/<session>`) and points back at the work
 * tree via `--work-tree`, so the project's own `.git` is never touched. Git always
 * ignores nested `.git` directories, so the project history is not captured.
 */
export function createCheckpointTracker(opts: { gitDir: string; workTree: string }): CheckpointTracker {
  const { gitDir, workTree } = opts;
  const git = (args: string[]) => runGit(gitDir, workTree, args);

  function ensureInit(): void {
    if (existsSync(join(gitDir, "HEAD"))) return;
    mkdirSync(gitDir, { recursive: true });
    git(["init", "-q"]);
  }

  function head(): string | null {
    const r = git(["rev-parse", "--short", "HEAD"]);
    return r.status === 0 ? r.stdout : null;
  }

  return {
    gitDir,
    workTree,

    snapshot(label, allowEmpty = false) {
      ensureInit();
      git(["add", "-A"]);
      // `diff --cached --quiet` exits non-zero when there is something staged.
      const hasStaged = git(["diff", "--cached", "--quiet"]).status !== 0;
      if (!hasStaged && !allowEmpty) {
        return null;
      }
      const args = ["commit", "-q", "--no-verify", "-m", label];
      if (!hasStaged && allowEmpty) args.push("--allow-empty");
      const commit = git(args);
      if (commit.status !== 0) return null;
      const id = head();
      return id ? { id, created: true } : null;
    },

    restore(id) {
      if (!existsSync(join(gitDir, "HEAD"))) {
        return { ok: false, message: "no checkpoints for this session" };
      }
      const exists = git(["cat-file", "-e", `${id}^{commit}`]);
      if (exists.status !== 0) {
        return { ok: false, message: `unknown checkpoint ${id}` };
      }
      const reset = git(["reset", "-q", "--hard", id]);
      if (reset.status !== 0) {
        return { ok: false, message: reset.stderr || "git reset failed" };
      }
      // Remove files created after the checkpoint; `-d` for dirs, no `-x` so
      // `.gitignore`d files are preserved.
      git(["clean", "-fd"]);
      return { ok: true, message: `restored to ${id}` };
    },

    list() {
      if (!existsSync(join(gitDir, "HEAD"))) return [];
      const r = git(["log", "--format=%h%x00%cI%x00%s"]);
      if (r.status !== 0 || !r.stdout) return [];
      return r.stdout
        .split("\n")
        .map((line) => {
          const [id, ts, label] = line.split("\0");
          return { id: id ?? "", ts: ts ?? "", label: label ?? "" };
        })
        .filter((e) => e.id);
    },
  };
}
