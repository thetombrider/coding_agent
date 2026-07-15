/**
 * Per-key read/write lock so operations touching the same path run in a safe
 * order while unrelated work proceeds in parallel.
 *
 * Writes acquire an exclusive lock; reads acquire a shared lock. Reads on the
 * same key run concurrently with each other but never overlap a write, and
 * locks are granted in the order they are requested (FIFO). This means that
 * within a single turn a read enqueued after a write to the same file observes
 * the write's result instead of stale data.
 */
import { bashMutationLocks, dedupeMutationLocks } from "./bash-mutation-paths.js";
import { INVOKE_TOOL_ID, unwrapInvokeArgs } from "../ratel/catalog.js";

interface KeyState {
  /** Resolves when the most recently enqueued write has settled. */
  lastWrite: Promise<unknown>;
  /** Reads enqueued since the last write; a new writer waits for all of them. */
  reads: Promise<unknown>[];
  /** Number of operations still in flight for this key. */
  pending: number;
}

export class MutationQueue {
  private readonly states = new Map<string, KeyState>();

  /** Run `fn` with exclusive access to `key` (writes). */
  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const state = this.stateFor(key);
    // Wait for everything enqueued before us: the last write and any reads
    // started since then. allSettled so a prior failure never blocks us.
    const gate = Promise.allSettled([state.lastWrite, ...state.reads]);
    const next = gate.then(fn);
    state.lastWrite = next;
    state.reads = [];
    this.track(key, state, next);
    return next;
  }

  /** Run `fn` with shared access to `key` (reads). */
  runShared<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const state = this.stateFor(key);
    // Wait only for the most recent write, then run alongside sibling reads.
    const next = state.lastWrite.catch(() => undefined).then(fn);
    state.reads.push(next);
    this.track(key, state, next);
    return next;
  }

  private stateFor(key: string): KeyState {
    let state = this.states.get(key);
    if (!state) {
      state = { lastWrite: Promise.resolve(), reads: [], pending: 0 };
      this.states.set(key, state);
    }
    return state;
  }

  private track(key: string, state: KeyState, op: Promise<unknown>): void {
    state.pending += 1;
    op.catch(() => undefined).finally(() => {
      state.pending -= 1;
      state.reads = state.reads.filter((r) => r !== op);
      if (state.pending === 0 && this.states.get(key) === state) {
        this.states.delete(key);
      }
    });
  }
}

const WRITE_TOOL_NAMES = new Set(["write", "edit", "file_op"]);
const READ_TOOL_NAMES = new Set(["read", "grep", "find", "ls", "search_symbols"]);

export function isWriteToolName(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name);
}

export type MutationMode = "shared" | "exclusive";

export interface MutationLock {
  key: string;
  mode: MutationMode;
}

function pathLock(
  path: string,
  mode: MutationMode,
  resolvePath: (cwd: string, path: string) => string,
  cwd: string,
): MutationLock {
  return { key: resolvePath(cwd, path), mode };
}

function pathArgLocks(
  name: string,
  args: unknown,
  resolvePath: (cwd: string, path: string) => string,
  cwd: string,
  pathKey: string,
  defaultPath?: string,
): MutationLock[] {
  if (typeof args !== "object" || args === null) return [];
  const raw = (args as Record<string, unknown>)[pathKey];
  const path = typeof raw === "string" && raw ? raw : defaultPath;
  if (!path) return [];
  const mode: MutationMode = WRITE_TOOL_NAMES.has(name) ? "exclusive" : "shared";
  return [pathLock(path, mode, resolvePath, cwd)];
}

function fileOpLocks(
  args: unknown,
  resolvePath: (cwd: string, path: string) => string,
  cwd: string,
): MutationLock[] {
  if (typeof args !== "object" || args === null) return [];
  const source = (args as { source?: unknown }).source;
  if (typeof source !== "string" || !source) return [];
  const locks = [pathLock(source, "exclusive", resolvePath, cwd)];
  const destination = (args as { destination?: unknown }).destination;
  if (typeof destination === "string" && destination) {
    locks.push(pathLock(destination, "exclusive", resolvePath, cwd));
  }
  return locks;
}

/**
 * Classify a tool call as workspace read(s) or write(s) on specific path(s),
 * or `[]` when it does not lock paths.
 */
export function mutationLocks(
  name: string,
  args: unknown,
  resolvePath: (cwd: string, path: string) => string,
  cwd: string,
): MutationLock[] {
  if (name === INVOKE_TOOL_ID) {
    if (typeof args !== "object" || args === null) return [];
    const toolId = (args as { toolId?: unknown }).toolId;
    if (typeof toolId !== "string" || !toolId) return [];
    return mutationLocks(
      toolId,
      unwrapInvokeArgs(args as Parameters<typeof unwrapInvokeArgs>[0]),
      resolvePath,
      cwd,
    );
  }

  if (name === "bash") {
    if (typeof args !== "object" || args === null) return [];
    const command = (args as { command?: unknown }).command;
    if (typeof command !== "string" || !command.trim()) return [];
    return bashMutationLocks(command, resolvePath, cwd);
  }

  if (name === "file_op") {
    return fileOpLocks(args, resolvePath, cwd);
  }

  if (name === "search_symbols") {
    return pathArgLocks(name, args, resolvePath, cwd, "file");
  }

  if (READ_TOOL_NAMES.has(name) || WRITE_TOOL_NAMES.has(name)) {
    if (name === "grep" || name === "find" || name === "ls") {
      return pathArgLocks(name, args, resolvePath, cwd, "path", ".");
    }
    return pathArgLocks(name, args, resolvePath, cwd, "path");
  }

  return [];
}

/** First lock for a tool call, if any. */
export function mutationLock(
  name: string,
  args: unknown,
  resolvePath: (cwd: string, path: string) => string,
  cwd: string,
): MutationLock | null {
  return mutationLocks(name, args, resolvePath, cwd)[0] ?? null;
}

/** Acquire every lock (sorted by key) before running `fn`. */
export function runWithMutationLocks<T>(
  queue: MutationQueue,
  locks: MutationLock[],
  fn: () => Promise<T>,
): Promise<T> {
  const ordered = dedupeMutationLocks(locks).sort((a, b) => {
    const keyCmp = a.key.localeCompare(b.key);
    if (keyCmp !== 0) return keyCmp;
    return a.mode === "exclusive" ? -1 : 1;
  });
  if (ordered.length === 0) return fn();

  const acquire = (index: number): Promise<T> => {
    if (index >= ordered.length) return fn();
    const lock = ordered[index]!;
    const next = () => acquire(index + 1);
    return lock.mode === "exclusive"
      ? queue.runExclusive(lock.key, next)
      : queue.runShared(lock.key, next);
  };
  return acquire(0);
}
