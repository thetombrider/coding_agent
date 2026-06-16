import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv", () => {
  let prevCwd: string;
  let prevHome: string | undefined;
  let tmp: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    prevHome = process.env.HOME;
    tmp = mkdtempSync(join(tmpdir(), "orin-env-"));
    delete process.env.ORIN_TEST_KEY;
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.ORIN_TEST_KEY;
  });

  it("loads variables from the global ~/.orin/.env regardless of cwd", () => {
    const home = join(tmp, "home");
    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(join(home, ".orin", ".env"), "ORIN_TEST_KEY=from-global\n", "utf8");
    process.env.HOME = home;

    const elsewhere = join(tmp, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    process.chdir(elsewhere);

    loadEnv();
    expect(process.env.ORIN_TEST_KEY).toBe("from-global");
  });

  it("loads a cwd-local .env for repo-local development", () => {
    process.env.HOME = join(tmp, "no-home");
    const repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, ".env"), "ORIN_TEST_KEY=from-cwd\n", "utf8");
    process.chdir(repo);

    loadEnv();
    expect(process.env.ORIN_TEST_KEY).toBe("from-cwd");
  });
});
