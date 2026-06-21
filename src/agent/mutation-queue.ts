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

const WRITE_TOOL_NAMES = new Set(["write", "edit"]);
const READ_TOOL_NAMES = new Set(["read"]);

export function isWriteToolName(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name);
}

export type MutationMode = "shared" | "exclusive";

export interface MutationLock {
  key: string;
  mode: MutationMode;
}

/**
 * Classify a tool call as a workspace read (shared) or write (exclusive) on a
 * specific path, or `null` if it does not lock a single path.
 */
export function mutationLock(
  name: string,
  args: unknown,
  resolvePath: (cwd: string, path: string) => string,
  cwd: string,
): MutationLock | null {
  const mode: MutationMode | null = WRITE_TOOL_NAMES.has(name)
    ? "exclusive"
    : READ_TOOL_NAMES.has(name)
      ? "shared"
      : null;
  if (!mode) return null;
  if (typeof args !== "object" || args === null) return null;
  const path = (args as { path?: unknown }).path;
  if (typeof path !== "string" || !path) return null;
  return { key: resolvePath(cwd, path), mode };
}
