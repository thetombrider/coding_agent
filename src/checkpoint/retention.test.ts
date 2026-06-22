import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RETENTION,
  gcShadowRepo,
  listShadowRepos,
  removeCheckpointRepo,
  runCheckpointCleanup,
  selectReposToPrune,
} from "./retention.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Generous ceiling: spawning a child (not awaiting it) should take well under this.
const GIT_GC_TIMEOUT_BUDGET_MS = 1000;

// Wait for a spawned git gc to finish so it isn't still writing into the temp
// dir when the test tears it down.
function waitForChild(child: import("node:child_process").ChildProcess | undefined): Promise<void> {
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
}

describe("selectReposToPrune", () => {
  const now = 1_000 * DAY_MS;

  it("removes repos older than the age window and keeps fresh ones", () => {
    const { remove, keep } = selectReposToPrune(
      [
        { sessionId: "fresh", mtimeMs: now - 1 * DAY_MS },
        { sessionId: "stale", mtimeMs: now - 40 * DAY_MS },
      ],
      { maxAgeMs: 30 * DAY_MS, maxRepos: 50, now },
    );
    expect(remove).toEqual(["stale"]);
    expect(keep).toEqual(["fresh"]);
  });

  it("enforces the count cap, keeping the newest repos", () => {
    const repos = Array.from({ length: 5 }, (_, i) => ({
      sessionId: `s${i}`,
      mtimeMs: now - i * 1000, // s0 newest … s4 oldest
    }));
    const { remove, keep } = selectReposToPrune(repos, { maxAgeMs: 30 * DAY_MS, maxRepos: 3, now });
    expect(keep).toEqual(["s0", "s1", "s2"]);
    expect(remove).toEqual(["s3", "s4"]);
  });

  it("never removes a protected session, even when stale or over the cap", () => {
    const repos = [
      { sessionId: "active", mtimeMs: now - 99 * DAY_MS }, // stale AND would be over a tiny cap
      { sessionId: "other", mtimeMs: now - 1 * DAY_MS },
    ];
    const { remove, keep } = selectReposToPrune(repos, {
      maxAgeMs: 30 * DAY_MS,
      maxRepos: 1,
      now,
      protect: ["active"],
    });
    expect(remove).not.toContain("active");
    expect(keep).toContain("active");
  });

  it("returns empty lists for no repos", () => {
    expect(selectReposToPrune([], { maxAgeMs: 1, maxRepos: 1, now })).toEqual({ remove: [], keep: [] });
  });
});

describe("retention filesystem operations", () => {
  let dir: string;

  const initRepo = (sessionId: string, ageMs = 0): string => {
    const gitDir = join(dir, sessionId);
    mkdirSync(gitDir, { recursive: true });
    spawnSync("git", [`--git-dir=${gitDir}`, "init", "-q"], { encoding: "utf8" });
    if (ageMs > 0) {
      const t = (Date.now() - ageMs) / 1000;
      utimesSync(gitDir, t, t);
    }
    return gitDir;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orin-retention-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists shadow repo directories and ignores stray files", () => {
    initRepo("s1");
    initRepo("s2");
    writeFileSync(join(dir, "not-a-repo.txt"), "x");
    const repos = listShadowRepos(dir).map((r) => r.sessionId).sort();
    expect(repos).toEqual(["s1", "s2"]);
  });

  it("removeCheckpointRepo deletes the dir and reports missing ones", () => {
    initRepo("s1");
    expect(removeCheckpointRepo("s1", dir)).toBe(true);
    expect(existsSync(join(dir, "s1"))).toBe(false);
    expect(removeCheckpointRepo("s1", dir)).toBe(false);
  });

  it("gcShadowRepo is a no-op on a non-repo and succeeds on a real one", async () => {
    expect(gcShadowRepo(join(dir, "missing"))).toBeUndefined();
    const gitDir = initRepo("s1");
    const child = gcShadowRepo(gitDir, 7);
    expect(child).toBeDefined();
    await waitForChild(child);
    // gc must not destroy the repo.
    expect(existsSync(join(gitDir, "HEAD"))).toBe(true);
  });

  it("gcShadowRepo is non-blocking (returns a live child without awaiting git)", async () => {
    const gitDir = initRepo("s1");
    const start = process.hrtime.bigint();
    const child = gcShadowRepo(gitDir, 7);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    // It spawns git and returns immediately — never the multi-second synchronous
    // `git gc` that froze the event loop during the capability handshake.
    expect(elapsedMs).toBeLessThan(GIT_GC_TIMEOUT_BUDGET_MS);
    await waitForChild(child); // settle before teardown
  });

  it("runCheckpointCleanup deletes stale repos, keeps recent ones, and protects the active session", async () => {
    initRepo("recent", 1 * DAY_MS);
    initRepo("stale", 40 * DAY_MS);
    initRepo("active", 90 * DAY_MS); // stale, but protected

    const result = runCheckpointCleanup({
      dir,
      maxAgeMs: 30 * DAY_MS,
      maxRepos: DEFAULT_RETENTION.maxRepos,
      protect: ["active"],
    });

    expect(result.removed).toEqual(["stale"]);
    expect(existsSync(join(dir, "stale"))).toBe(false);
    expect(existsSync(join(dir, "recent"))).toBe(true);
    expect(existsSync(join(dir, "active"))).toBe(true);
    expect(result.kept.sort()).toEqual(["active", "recent"]);
    await result.pending; // let the background gc finish before teardown
  });

  it("runCheckpointCleanup enforces the count cap", async () => {
    for (let i = 0; i < 4; i++) initRepo(`s${i}`, i * 1000); // s0 newest
    const result = runCheckpointCleanup({ dir, maxRepos: 2, maxAgeMs: 365 * DAY_MS });
    expect(existsSync(join(dir, "s0"))).toBe(true);
    expect(existsSync(join(dir, "s1"))).toBe(true);
    expect(existsSync(join(dir, "s2"))).toBe(false);
    expect(existsSync(join(dir, "s3"))).toBe(false);
    expect(result.kept.length).toBe(2);
    await result.pending;
  });

  it("runCheckpointCleanup is a no-op when the dir is empty or missing", async () => {
    const result = runCheckpointCleanup({ dir: join(dir, "nope") });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([]);
    await result.pending;
  });
});
