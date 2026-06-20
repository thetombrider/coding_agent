/**
 * Subagent workspace isolation — shared source of truth for the mode type, the
 * escalate-only resolution policy, and labels used by config, the task tool, and
 * the TUI settings menu. Kept dependency-free to avoid import cycles.
 */

export type IsolationMode = "shared" | "worktree" | "sandbox";

export const ISOLATION_MODES: readonly IsolationMode[] = ["shared", "worktree", "sandbox"];

/** Increasing degree of isolation. Used to clamp/escalate but never weaken. */
const RANK: Record<IsolationMode, number> = { shared: 0, worktree: 1, sandbox: 2 };

export const ISOLATION_LABELS: Record<IsolationMode, string> = {
  shared: "shared — edits the local working tree (changes persist)",
  worktree: "worktree — runs on an isolated git branch (changes persist)",
  sandbox: "sandbox — ephemeral E2B clone (changes discarded; needs E2B_API_KEY)",
};

/** The more-isolated of two modes. */
export function maxIsolation(a: IsolationMode, b: IsolationMode): IsolationMode {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Parse a user/config string into a mode, or undefined when unrecognized. */
export function coerceIsolation(raw: string): IsolationMode | undefined {
  const v = raw.trim().toLowerCase();
  return (ISOLATION_MODES as readonly string[]).includes(v) ? (v as IsolationMode) : undefined;
}

/**
 * Resolve the isolation a subagent should run under (Option A: floor + escalate).
 * The config `floor` is a guarantee — the model's per-call `requested` value may
 * escalate to a more-isolated mode but never weaken below the floor. Read-only
 * presets don't mutate, so the floor doesn't apply: they honour an explicit
 * request or fall back to the preset default (shared).
 */
export function resolveIsolationMode(
  requested: IsolationMode | undefined,
  mutating: boolean,
  presetDefault: IsolationMode,
  floor: IsolationMode,
): IsolationMode {
  if (!mutating) return requested ?? presetDefault;
  const base = maxIsolation(floor, presetDefault);
  return requested ? maxIsolation(base, requested) : base;
}
