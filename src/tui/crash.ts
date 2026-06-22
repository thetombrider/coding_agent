/**
 * Crash diagnostics for the interactive TUI.
 *
 * Orin's renderer runs on Bun's FFI plus a native (Zig) layer. When that layer
 * — or Bun itself — aborts (for example when the machine sleeps and the terminal
 * is torn out from under a resuming process), the process dies with a bare exit
 * code and no trail, so a bug report is just "it crashed with code 7" (#194).
 *
 * Two complementary breadcrumbs make those crashes diagnosable:
 *
 *  1. JS-level `uncaughtException` / `unhandledRejection` handlers append a
 *     structured entry to `~/.orin/crash.log`. (OpenTUI installs its own
 *     swallowing handlers; Node runs every listener, so ours coexist and never
 *     change the running app's behavior — we only log.)
 *  2. An "active runs" sentinel: each session records itself on start and clears
 *     itself on a clean `exit`. A native abort or hard kill never reaches that
 *     clean exit, so the entry lingers; the next launch sees a dead pid that was
 *     never cleared and reports the previous session as having crashed. This is
 *     the only signal that survives a crash below the JS layer.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function orinDir(): string {
  return join(homedir(), ".orin");
}

export function crashLogPath(): string {
  return join(orinDir(), "crash.log");
}

function activeRunsPath(): string {
  return join(orinDir(), "active-runs.json");
}

interface ActiveRun {
  pid: number;
  sessionId: string;
  startedAt: string;
  cwd: string;
}

export type PreviousCrash = ActiveRun;

export interface CrashDiagnostics {
  /** Prior sessions that never reached a clean exit (reported once). */
  previousCrashes: PreviousCrash[];
  /** Record a clean shutdown so this run is not flagged as a crash. Idempotent. */
  markCleanExit: () => void;
  /** Detach the process-level error listeners. */
  dispose: () => void;
}

function ensureOrinDir(): void {
  const dir = orinDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function appendCrashLog(entry: Record<string, unknown>): void {
  try {
    ensureOrinDir();
    appendFileSync(
      crashLogPath(),
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
    );
  } catch {
    // Diagnostics must never themselves crash the session.
  }
}

/** True if `pid` is a live process this user can see. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH → no such process; EPERM → alive but not ours (still "alive").
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function readActiveRuns(): ActiveRun[] {
  try {
    const parsed = JSON.parse(readFileSync(activeRunsPath(), "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as ActiveRun[]) : [];
  } catch {
    return [];
  }
}

function writeActiveRuns(runs: ActiveRun[]): void {
  try {
    ensureOrinDir();
    writeFileSync(activeRunsPath(), JSON.stringify(runs));
  } catch {
    // Best-effort: a missing sentinel just means no crash detection next launch.
  }
}

function describeError(value: unknown): Record<string, unknown> {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack };
  }
  return { message: String(value) };
}

export function installCrashDiagnostics(opts: {
  sessionId: string;
  getCwd: () => string;
}): CrashDiagnostics {
  const self: ActiveRun = {
    pid: process.pid,
    sessionId: opts.sessionId,
    startedAt: new Date().toISOString(),
    cwd: opts.getCwd(),
  };

  // Split prior entries into still-running sessions (other live Orin instances)
  // and dead ones that never cleared themselves — the latter are crashes.
  const prior = readActiveRuns().filter((r) => r.pid !== process.pid);
  const previousCrashes = prior.filter((r) => !isProcessAlive(r.pid));
  const survivors = prior.filter((r) => isProcessAlive(r.pid));
  for (const crash of previousCrashes) {
    appendCrashLog({ kind: "unclean_shutdown", ...crash });
  }
  writeActiveRuns([...survivors, self]);

  const onUncaughtException = (err: unknown) =>
    appendCrashLog({ kind: "uncaughtException", error: describeError(err) });
  const onUnhandledRejection = (reason: unknown) =>
    appendCrashLog({ kind: "unhandledRejection", error: describeError(reason) });
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);

  let cleared = false;
  const markCleanExit = () => {
    if (cleared) return;
    cleared = true;
    // Re-read so a concurrently started instance's entry is preserved.
    writeActiveRuns(readActiveRuns().filter((r) => r.pid !== process.pid));
  };

  // A clean process exit (normal quit, Ctrl-C, or a signal whose loop drains)
  // fires "exit" and clears the sentinel. A native abort never gets here, so the
  // entry survives and the next launch reports the crash.
  process.once("exit", markCleanExit);

  return {
    previousCrashes,
    markCleanExit,
    dispose: () => {
      process.removeListener("uncaughtException", onUncaughtException);
      process.removeListener("unhandledRejection", onUnhandledRejection);
      process.removeListener("exit", markCleanExit);
    },
  };
}
