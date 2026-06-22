import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crashLogPath, installCrashDiagnostics } from "./crash.js";

const readJsonl = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const readActiveRuns = (home: string) =>
  JSON.parse(readFileSync(join(home, ".orin", "active-runs.json"), "utf8")) as Array<{
    pid: number;
    sessionId: string;
  }>;

describe("installCrashDiagnostics", () => {
  let home: string;
  let prevHome: string | undefined;
  const disposers: Array<() => void> = [];

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-crash-test-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    while (disposers.length) disposers.pop()!();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  const install = (sessionId: string) => {
    const crash = installCrashDiagnostics({ sessionId, getCwd: () => "/work" });
    disposers.push(crash.dispose);
    return crash;
  };

  it("records the current run and reports no crash on a fresh start", () => {
    const crash = install("sess-1");
    expect(crash.previousCrashes).toEqual([]);
    const runs = readActiveRuns(home);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ pid: process.pid, sessionId: "sess-1" });
  });

  it("flags a prior run whose process is gone and never cleared itself", () => {
    // A dead pid that was never removed from the sentinel = an unclean shutdown.
    const deadPid = 2147480000;
    mkdirSync(join(home, ".orin"), { recursive: true });
    writeFileSync(
      join(home, ".orin", "active-runs.json"),
      JSON.stringify([
        { pid: deadPid, sessionId: "old", startedAt: "2020-01-01T00:00:00Z", cwd: "/work" },
      ]),
    );

    const crash = install("sess-2");
    expect(crash.previousCrashes).toHaveLength(1);
    expect(crash.previousCrashes[0]).toMatchObject({ pid: deadPid, sessionId: "old" });

    const logged = readJsonl(crashLogPath());
    expect(logged.some((e) => e.kind === "unclean_shutdown" && e.pid === deadPid)).toBe(true);

    // The dead entry is pruned and replaced by the current run.
    const runs = readActiveRuns(home);
    expect(runs.map((r) => r.pid)).toEqual([process.pid]);
  });

  it("markCleanExit removes the current run from the sentinel", () => {
    const crash = install("sess-3");
    expect(readActiveRuns(home)).toHaveLength(1);
    crash.markCleanExit();
    expect(readActiveRuns(home)).toHaveLength(0);
  });

  it("dispose detaches the process error listeners", () => {
    const before = process.listenerCount("uncaughtException");
    const crash = install("sess-4");
    expect(process.listenerCount("uncaughtException")).toBe(before + 1);
    crash.dispose();
    expect(process.listenerCount("uncaughtException")).toBe(before);
    disposers.pop(); // already disposed
  });
});
