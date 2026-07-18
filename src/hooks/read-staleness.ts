import { loadConfig } from "../config/config.js";
import { pathsFromGrepOutput } from "../filetracker/grep-paths.js";
import { getFileMtimeMs } from "../filetracker/mtime.js";
import { ReadTracker } from "../filetracker/read-tracker.js";
import { resolvePath } from "../util/paths.js";
import type { HookRegistryImpl } from "./registry.js";
import type { AgentContext } from "../types.js";

function pathFromArgs(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const rec = args as Record<string, unknown>;
  return typeof rec.path === "string" ? rec.path : null;
}

function stalenessWarning(relPath: string, reason: "never_read" | "stale"): string {
  if (reason === "never_read") {
    return `[staleness: ${relPath} was not read this session — re-read before editing]`;
  }
  return `[staleness: ${relPath} changed on disk since last read — re-read before editing]`;
}

function displayPath(cwd: string, absPath: string): string {
  if (absPath.startsWith(cwd + "/")) return absPath.slice(cwd.length + 1);
  return absPath;
}

function requireFreshRead(): boolean {
  return loadConfig().tools?.edit?.requireFreshRead === true;
}

export function attachReadTracker(ctx: AgentContext, tracker?: ReadTracker): ReadTracker {
  const instance = tracker ?? new ReadTracker();
  ctx.readTracker = instance;
  return instance;
}

export function installReadStalenessHooks(hooks: HookRegistryImpl): void {
  hooks.on("before_tool", async ({ name, args }, ctx) => {
    if (name !== "edit" && name !== "write") return;
    const tracker = ctx.readTracker;
    if (!tracker) return;

    const path = pathFromArgs(args);
    if (!path) return;

    const absPath = resolvePath(ctx.cwd, path);
    const mtime = await getFileMtimeMs(ctx, path);
    if (mtime === null) return;

    const reason = tracker.checkStale(absPath, mtime);
    if (!reason) return;

    const rel = displayPath(ctx.cwd, absPath);
    const warning = stalenessWarning(rel, reason);
    if (requireFreshRead()) {
      return { block: true, reason: warning };
    }
    tracker.setPendingWarning(absPath, warning);
  });

  hooks.on("after_tool", async ({ name, args, output, isError }, ctx) => {
    const tracker = ctx.readTracker;
    if (!tracker) return;

    if (name === "read") {
      if (isError) return;
      const path = pathFromArgs(args);
      if (!path) return;
      const mtime = await getFileMtimeMs(ctx, path);
      if (mtime === null) return;
      tracker.recordRead(resolvePath(ctx.cwd, path), mtime);
      return;
    }

    if (name === "grep") {
      if (isError) return;
      for (const absPath of pathsFromGrepOutput(ctx.cwd, output)) {
        const mtime = await getFileMtimeMs(ctx, absPath);
        if (mtime !== null) tracker.recordRead(absPath, mtime);
      }
      return;
    }

    if (name !== "edit" && name !== "write") return;
    if (isError) return;

    const path = pathFromArgs(args);
    if (!path) return;

    const absPath = resolvePath(ctx.cwd, path);
    const mtime = await getFileMtimeMs(ctx, path);
    if (mtime === null) return;

    const warning = tracker.takePendingWarning(absPath);
    tracker.markWritten(absPath, mtime);

    if (!warning) return;
    return { output: `${output}\n\n${warning}` };
  });
}
