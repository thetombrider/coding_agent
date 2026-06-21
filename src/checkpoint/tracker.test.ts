import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckpointTracker, isMutatingTool } from "./tracker.js";

describe("isMutatingTool", () => {
  it("flags write/edit/bash and nothing else", () => {
    expect(isMutatingTool("write")).toBe(true);
    expect(isMutatingTool("edit")).toBe(true);
    expect(isMutatingTool("bash")).toBe(true);
    expect(isMutatingTool("read")).toBe(false);
    expect(isMutatingTool("grep")).toBe(false);
  });
});

describe("createCheckpointTracker", () => {
  let work: string;
  let gitDir: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "orin-cp-"));
    work = join(base, "work");
    gitDir = join(base, "shadow");
    mkdirSync(work, { recursive: true });
  });

  afterEach(() => {
    // base is the parent of both work and gitDir
    rmSync(join(work, ".."), { recursive: true, force: true });
  });

  const tracker = () => createCheckpointTracker({ gitDir, workTree: work });

  it("snapshots changes and skips no-op commits", () => {
    const t = tracker();
    writeFileSync(join(work, "a.txt"), "one");
    const first = t.snapshot("first");
    expect(first?.created).toBe(true);

    // No change → no new checkpoint.
    expect(t.snapshot("noop")).toBeNull();

    writeFileSync(join(work, "a.txt"), "two");
    const second = t.snapshot("second");
    expect(second?.created).toBe(true);
    expect(second?.id).not.toBe(first?.id);
  });

  it("baselines an empty tree with allowEmpty", () => {
    const t = tracker();
    const base = t.snapshot("baseline", true);
    expect(base?.created).toBe(true);
    expect(t.list().length).toBe(1);
  });

  it("restores file contents and removes files added since", () => {
    const t = tracker();
    writeFileSync(join(work, "a.txt"), "original");
    const cp = t.snapshot("cp1")!;

    writeFileSync(join(work, "a.txt"), "edited");
    writeFileSync(join(work, "b.txt"), "new file");

    const res = t.restore(cp.id);
    expect(res.ok).toBe(true);
    expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("original");
    expect(existsSync(join(work, "b.txt"))).toBe(false);
  });

  it("honors .gitignore and never touches the project's real .git", () => {
    writeFileSync(join(work, ".gitignore"), "ignored.txt\n");
    // A nested .git directory simulating the project's real repo.
    mkdirSync(join(work, ".git"), { recursive: true });
    writeFileSync(join(work, ".git", "HEAD"), "ref: refs/heads/main");

    const t = tracker();
    writeFileSync(join(work, "tracked.txt"), "v1");
    writeFileSync(join(work, "ignored.txt"), "secret");
    const cp = t.snapshot("cp1")!;

    // Mutate the ignored file and the project .git, then restore.
    writeFileSync(join(work, "ignored.txt"), "changed");
    writeFileSync(join(work, ".git", "HEAD"), "ref: refs/heads/other");
    t.restore(cp.id);

    // Ignored files and the real .git are left as-is (not captured/reverted).
    expect(readFileSync(join(work, "ignored.txt"), "utf8")).toBe("changed");
    expect(readFileSync(join(work, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/other");
  });

  it("rejects restoring an unknown checkpoint", () => {
    const t = tracker();
    writeFileSync(join(work, "a.txt"), "x");
    t.snapshot("cp1");
    expect(t.restore("deadbeef").ok).toBe(false);
  });

  it("does not capture the project's git history", () => {
    // Initialize a real git repo with a committed file in the work tree.
    const realGit = (args: string[]) =>
      spawnSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        encoding: "utf8",
      });
    realGit(["init", "-q"]);
    writeFileSync(join(work, "real.txt"), "committed");
    realGit(["add", "-A"]);
    realGit(["commit", "-qm", "real"]);

    const t = tracker();
    const cp = t.snapshot("cp1", true);
    expect(cp).not.toBeNull();
    // The shadow repo's HEAD tree must not include .git internals.
    const ls = spawnSync(
      "git",
      [`--git-dir=${gitDir}`, `--work-tree=${work}`, "ls-tree", "-r", "--name-only", "HEAD"],
      { encoding: "utf8" },
    );
    expect(ls.stdout).toContain("real.txt");
    expect(ls.stdout).not.toContain(".git/");
  });
});
