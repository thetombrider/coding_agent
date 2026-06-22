import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGitOriginUrl, safeRemoteLabel, seedRepoIntoWorkspace } from "./seed.js";
import type { Workspace } from "./types.js";

describe("safeRemoteLabel", () => {
  it("derives owner/repo from an https URL and strips .git", () => {
    expect(safeRemoteLabel("https://github.com/acme/widgets.git")).toBe("acme/widgets");
  });

  it("converts scp-style git@ syntax to a clean path", () => {
    expect(safeRemoteLabel("git@github.com:acme/widgets.git")).toBe("acme/widgets");
  });

  it("strips embedded credentials from the URL", () => {
    expect(safeRemoteLabel("https://user:token@github.com/acme/widgets.git")).toBe(
      "acme/widgets",
    );
  });

  it("falls back to the trailing path segment for unparseable URLs", () => {
    expect(safeRemoteLabel("some/weird/thing.git")).toBe("thing");
  });
});

describe("getGitOriginUrl", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orin-seed-git-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined when there is no origin remote", () => {
    execSync("git init -q", { cwd: dir });
    expect(getGitOriginUrl(dir)).toBeUndefined();
  });

  it("reads the configured origin url", () => {
    execSync("git init -q", { cwd: dir });
    execSync("git remote add origin https://example.com/acme/repo.git", { cwd: dir });
    expect(getGitOriginUrl(dir)).toBe("https://example.com/acme/repo.git");
  });
});

describe("seedRepoIntoWorkspace", () => {
  let dir: string;

  function fakeWorkspace(execImpl: Workspace["exec"]): Workspace {
    return {
      kind: "e2b",
      exec: execImpl,
      readFile: async () => "",
      writeFile: async () => {},
      list: async () => [],
      stat: async () => null,
      deleteFile: async () => {},
      move: async () => {},
      dispose: async () => {},
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orin-seed-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns guidance when the local repo has no origin", async () => {
    execSync("git init -q", { cwd: dir });
    const ws = fakeWorkspace(async () => ({ exitCode: 0 }));
    const msg = await seedRepoIntoWorkspace(ws, dir);
    expect(msg).toMatch(/No git origin found/);
  });

  it("clones into the remote root and reports success", async () => {
    execSync("git init -q", { cwd: dir });
    execSync("git remote add origin https://example.com/acme/repo.git", { cwd: dir });

    const commands: string[] = [];
    const ws = fakeWorkspace(async (command) => {
      commands.push(command);
      return { exitCode: 0 };
    });

    const msg = await seedRepoIntoWorkspace(ws, dir, "/remote/proj");
    expect(msg).toBe("Cloned acme/repo into sandbox");
    expect(commands.some((c) => c.includes("mkdir -p") && c.includes("/remote/proj"))).toBe(true);
    expect(commands.some((c) => c.includes("git clone --depth 1"))).toBe(true);
  });

  it("reports the exit code when the clone fails", async () => {
    execSync("git init -q", { cwd: dir });
    execSync("git remote add origin https://example.com/acme/repo.git", { cwd: dir });

    const ws = fakeWorkspace(async (command) =>
      command.includes("git clone") ? { exitCode: 128 } : { exitCode: 0 },
    );

    const msg = await seedRepoIntoWorkspace(ws, dir);
    expect(msg).toBe("git clone failed (exit 128)");
  });
});
