import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkpointsDir } from "./tracker.js";

/**
 * Shadow-git checkpoint repos under `~/.orin/checkpoints/<session>` are created
 * per session and, left alone, grow without bound — each `git add -A` snapshot
 * accumulates loose objects, and dead session dirs are never reclaimed. OpenCode
 * hit the same problem (anomalyco/opencode#6845, "HUGE snapshot folder") and
 * mitigated it with a periodic `git gc --prune` per shadow repo plus pruning of
 * old session dirs. This module is orin's equivalent: it `git gc`s the repos worth
 * keeping and deletes the rest under an age window + count cap.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionOptions {
  /** Delete shadow repos whose last activity is older than this (default 30d). */
  maxAgeMs?: number;
  /** Keep at most this many shadow repos, newest first (default 50). */
  maxRepos?: number;
  /** `git gc --prune` window in days for the survivors (default 7). */
  pruneDays?: number;
  /** Session ids that must never be deleted (e.g. the active session). */
  protect?: string[];
  /** Checkpoints root; overridable for tests. Defaults to {@link checkpointsDir}. */
  dir?: string;
}

/** Defaults tuned to stay well within a few hundred MB of shadow history. */
export const DEFAULT_RETENTION = {
  maxAgeMs: 30 * DAY_MS,
  maxRepos: 50,
  pruneDays: 7,
} as const;

export interface ShadowRepo {
  sessionId: string;
  /** Last-modified time of the shadow git dir, used as a proxy for last activity. */
  mtimeMs: number;
}

/**
 * Decide which shadow repos to delete given an age window and a count cap. Pure
 * (no I/O) so the policy is unit-testable. Repos are ranked newest-first; a repo
 * is removed when it is older than `maxAgeMs` OR falls beyond the newest
 * `maxRepos`. Protected ids are always kept and still occupy a keep slot.
 */
export function selectReposToPrune(
  repos: ShadowRepo[],
  opts: { maxAgeMs: number; maxRepos: number; now: number; protect?: string[] },
): { remove: string[]; keep: string[] } {
  const protectedSet = new Set(opts.protect ?? []);
  const sorted = [...repos].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const remove = new Set<string>();

  // Age cap: anything past the window goes, unless protected.
  for (const r of sorted) {
    if (protectedSet.has(r.sessionId)) continue;
    if (opts.now - r.mtimeMs > opts.maxAgeMs) remove.add(r.sessionId);
  }

  // Count cap: keep the newest `maxRepos` survivors; trim the rest (never protected).
  const survivors = sorted.filter((r) => !remove.has(r.sessionId));
  survivors.forEach((r, i) => {
    if (i >= opts.maxRepos && !protectedSet.has(r.sessionId)) remove.add(r.sessionId);
  });

  return {
    remove: sorted.filter((r) => remove.has(r.sessionId)).map((r) => r.sessionId),
    keep: sorted.filter((r) => !remove.has(r.sessionId)).map((r) => r.sessionId),
  };
}

/** List the shadow repos under `dir`, newest-first is not guaranteed (caller sorts). */
export function listShadowRepos(dir: string = checkpointsDir()): ShadowRepo[] {
  if (!existsSync(dir)) return [];
  const out: ShadowRepo[] = [];
  for (const name of readdirSync(dir)) {
    try {
      const st = statSync(join(dir, name));
      if (st.isDirectory()) out.push({ sessionId: name, mtimeMs: st.mtimeMs });
    } catch {
      // ignore entries that vanished or can't be stat'd
    }
  }
  return out;
}

/** Delete a single session's shadow repo. Returns false when there was nothing to delete. */
export function removeCheckpointRepo(sessionId: string, dir: string = checkpointsDir()): boolean {
  const full = join(dir, sessionId);
  if (!existsSync(full)) return false;
  rmSync(full, { recursive: true, force: true });
  return true;
}

const GIT_GC_TIMEOUT_MS = 30_000;

/**
 * Repack and prune a shadow repo's objects. Best-effort and **non-blocking**: it
 * spawns `git gc` asynchronously and returns immediately, so it never stalls the
 * caller's event loop.
 *
 * This matters at TUI startup. A synchronous `spawnSync` here would freeze the
 * Node/Bun event loop for the whole duration of `git gc` (tens to hundreds of ms
 * on a repo with history). That freeze lands right in OpenTUI's native terminal
 * capability handshake window, perturbing it enough that the native layer emits
 * its Kitty graphics probe — which Terminal.app then paints into the prompt. An
 * async spawn keeps the event loop free so the handshake runs undisturbed.
 *
 * Returns the spawned child (or `undefined` when there is nothing to gc) so a
 * caller that wants to await completion — e.g. a test, or {@link runCheckpointCleanup}'s
 * `pending` — can; production callers fire-and-forget.
 */
export function gcShadowRepo(
  gitDir: string,
  pruneDays: number = DEFAULT_RETENTION.pruneDays,
): ChildProcess | undefined {
  if (!existsSync(join(gitDir, "HEAD"))) return undefined;
  try {
    const child = spawn(
      "git",
      [`--git-dir=${gitDir}`, "gc", "--quiet", `--prune=${pruneDays}.days`],
      { stdio: "ignore", timeout: GIT_GC_TIMEOUT_MS },
    );
    // Never let a stray gc keep the process alive, and swallow spawn errors
    // (e.g. git missing) so cleanup is purely best-effort.
    child.unref();
    child.on("error", () => {});
    return child;
  } catch {
    // best-effort
    return undefined;
  }
}

export interface CleanupResult {
  removed: string[];
  kept: string[];
  /**
   * Resolves once every spawned `git gc` has exited. Production callers ignore
   * this (the gc is fire-and-forget); tests await it to avoid racing teardown
   * against a still-writing git.
   */
  pending: Promise<void>;
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
}

/**
 * Run one pass of checkpoint cleanup: delete shadow repos beyond the age/count
 * caps, then `git gc --prune` the survivors. Pruning decisions and dir removals
 * are synchronous; the `git gc` of survivors is spawned asynchronously (so it
 * never blocks the event loop) and awaitable via the returned `pending`.
 * Best-effort — callers that must not block startup should use
 * {@link scheduleCheckpointCleanup}.
 */
export function runCheckpointCleanup(opts: RetentionOptions = {}): CleanupResult {
  const dir = opts.dir ?? checkpointsDir();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_RETENTION.maxAgeMs;
  const maxRepos = opts.maxRepos ?? DEFAULT_RETENTION.maxRepos;
  const pruneDays = opts.pruneDays ?? DEFAULT_RETENTION.pruneDays;

  const repos = listShadowRepos(dir);
  if (repos.length === 0) return { removed: [], kept: [], pending: Promise.resolve() };

  const { remove, keep } = selectReposToPrune(repos, {
    maxAgeMs,
    maxRepos,
    now: Date.now(),
    protect: opts.protect,
  });

  for (const id of remove) removeCheckpointRepo(id, dir);
  const children: ChildProcess[] = [];
  for (const id of keep) {
    const child = gcShadowRepo(join(dir, id), pruneDays);
    if (child) children.push(child);
  }

  const pending = Promise.all(children.map(waitForExit)).then(() => undefined);
  return { removed: remove, kept: keep, pending };
}

/**
 * Kick off a cleanup pass off the startup path so it never blocks the TUI from
 * coming up. Deferred on an unref'd timer (won't keep the process alive) and
 * fully error-swallowed.
 *
 * `delayMs` pushes the pass clear of the terminal capability handshake that runs
 * while the renderer initializes; callers on the startup path should pass a small
 * delay so the (now non-blocking, but still I/O-spawning) cleanup never races it.
 */
export function scheduleCheckpointCleanup(opts: RetentionOptions = {}, delayMs = 0): void {
  const timer = setTimeout(() => {
    try {
      runCheckpointCleanup(opts);
    } catch {
      // best-effort: cleanup must never crash the session
    }
  }, delayMs);
  // Don't let the cleanup timer hold the event loop open on exit.
  timer.unref?.();
}
