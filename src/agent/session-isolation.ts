/**
 * Whole-session workspace isolation — parent loop only (`shared` | `worktree`).
 * Subagent isolation adds `sandbox`; kept separate to avoid conflating the two.
 */

export type SessionIsolationMode = "shared" | "worktree";

export const SESSION_ISOLATION_MODES: readonly SessionIsolationMode[] = ["shared", "worktree"];

export const SESSION_ISOLATION_LABELS: Record<SessionIsolationMode, string> = {
  shared: "shared — main agent edits the host working tree",
  worktree: "worktree — main agent runs on an isolated git branch",
};

export function coerceSessionIsolation(raw: string): SessionIsolationMode | undefined {
  const v = raw.trim().toLowerCase();
  return (SESSION_ISOLATION_MODES as readonly string[]).includes(v)
    ? (v as SessionIsolationMode)
    : undefined;
}
