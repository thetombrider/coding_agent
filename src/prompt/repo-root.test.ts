import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findRepoRoot } from "./repo-root.js";

describe("findRepoRoot", () => {
  let root: string;

  beforeEach(() => {
    // realpath so macOS /var → /private/var symlinks don't break equality.
    root = realpathSync(mkdtempSync(join(tmpdir(), "orin-reporoot-")));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds the git toplevel from a nested directory", () => {
    execSync("git init -q", { cwd: root });
    const nested = join(root, "src", "deep");
    mkdirSync(nested, { recursive: true });

    expect(findRepoRoot(nested)).toBe(root);
  });

  it("finds a .git directory without invoking git when not a work tree", () => {
    // A bare `.git` dir that `git rev-parse` won't accept as a work tree,
    // exercising the filesystem-walk fallback.
    mkdirSync(join(root, ".git"), { recursive: true });
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });

    expect(findRepoRoot(nested)).toBe(root);
  });

  it("returns undefined when no repo marker exists in any ancestor", () => {
    const isolated = realpathSync(mkdtempSync(join(tmpdir(), "orin-norepo-")));
    try {
      // Skip if this temp area happens to sit inside a real repo (e.g. CI checkout).
      const detected = findRepoRoot(isolated);
      if (detected !== undefined) {
        expect(detected).not.toBe(isolated);
      } else {
        expect(detected).toBeUndefined();
      }
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});
