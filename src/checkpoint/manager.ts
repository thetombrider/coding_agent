import { checkpointGitDir, createCheckpointTracker, type CheckpointTracker } from "./tracker.js";

export interface CheckpointRecord {
  id: string;
  label: string;
  ts: string;
  /** Tool that triggered the checkpoint, or "baseline" / "restore". */
  tool: string;
}

export interface CheckpointManagerDeps {
  /** Current session id (re-read each call so /new and /resume are reflected). */
  getSessionId: () => string;
  /** Current work tree — the local workspace cwd. */
  getWorkTree: () => string;
  /** Checkpoints are local-only; E2B sandboxes are already disposable. */
  isLocalWorkspace: () => boolean;
  /** Persist a checkpoint to the session log so it survives resume. */
  record: (rec: CheckpointRecord) => void;
  /** Overridable for tests; defaults to `~/.orin/checkpoints/<session>`. */
  gitDirFor?: (sessionId: string) => string;
  createTracker?: typeof createCheckpointTracker;
}

export interface CheckpointManager {
  /** Snapshot the initial state so the first edit can be undone. Idempotent per session. */
  baseline(): void;
  /** Snapshot after a mutating tool. Returns the new checkpoint, or null if nothing changed. */
  afterTool(tool: string): CheckpointRecord | null;
  /** Checkpoints for the active session, newest first. */
  list(): CheckpointRecord[];
  /** Roll the work tree back to `id` (or the latest checkpoint when omitted). */
  restore(id?: string): { ok: boolean; message: string };
  /** Bind to a session and seed its known checkpoints (e.g. replayed from the log on resume). */
  bind(sessionId: string, records: CheckpointRecord[]): void;
}

export function createCheckpointManager(deps: CheckpointManagerDeps): CheckpointManager {
  const gitDirFor = deps.gitDirFor ?? checkpointGitDir;
  const makeTracker = deps.createTracker ?? createCheckpointTracker;
  // Records per session id; bind/baseline keep this in sync with the live session.
  const bySession = new Map<string, CheckpointRecord[]>();
  const baselined = new Set<string>();

  const tracker = (sessionId: string): CheckpointTracker =>
    makeTracker({ gitDir: gitDirFor(sessionId), workTree: deps.getWorkTree() });

  const records = (sessionId: string): CheckpointRecord[] => {
    let list = bySession.get(sessionId);
    if (!list) {
      list = [];
      bySession.set(sessionId, list);
    }
    return list;
  };

  const push = (sessionId: string, rec: CheckpointRecord) => {
    records(sessionId).push(rec);
    deps.record(rec);
  };

  return {
    bind(sessionId, seeded) {
      bySession.set(sessionId, [...seeded]);
      // A session resumed with existing checkpoints already has a baseline.
      if (seeded.length > 0) baselined.add(sessionId);
    },

    baseline() {
      if (!deps.isLocalWorkspace()) return;
      const sessionId = deps.getSessionId();
      if (baselined.has(sessionId)) return;
      baselined.add(sessionId);
      const snap = tracker(sessionId).snapshot("session baseline", true);
      if (snap) {
        push(sessionId, { id: snap.id, label: "session baseline", ts: new Date().toISOString(), tool: "baseline" });
      }
    },

    afterTool(tool) {
      if (!deps.isLocalWorkspace()) return null;
      const sessionId = deps.getSessionId();
      // Guarantee a baseline exists before the first recorded edit.
      if (!baselined.has(sessionId)) this.baseline();
      const label = `after ${tool}`;
      const snap = tracker(sessionId).snapshot(label);
      if (!snap || !snap.created) return null;
      const rec: CheckpointRecord = { id: snap.id, label, ts: new Date().toISOString(), tool };
      push(sessionId, rec);
      return rec;
    },

    list() {
      return [...records(deps.getSessionId())].reverse();
    },

    restore(id) {
      if (!deps.isLocalWorkspace()) {
        return { ok: false, message: "checkpoints are local-only (E2B sandboxes are disposable)" };
      }
      const sessionId = deps.getSessionId();
      const known = records(sessionId);
      if (known.length === 0) {
        return { ok: false, message: "no checkpoints yet — make an edit first" };
      }
      const target = id ? known.find((r) => r.id === id) : known[known.length - 1];
      if (!target) {
        return { ok: false, message: `unknown checkpoint ${id}` };
      }
      const t = tracker(sessionId);
      // Snapshot current state first so the restore is itself reversible.
      const safety = t.snapshot("pre-restore safety");
      if (safety?.created) {
        push(sessionId, { id: safety.id, label: "pre-restore safety", ts: new Date().toISOString(), tool: "restore" });
      }
      return t.restore(target.id);
    },
  };
}
