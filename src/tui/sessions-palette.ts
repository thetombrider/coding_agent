import type { SessionSummary } from "../session/log.js";

export type SessionsPaletteState = {
  phase: "sessions";
  index: number;
  sessions: SessionSummary[];
  menu: "list" | "delete";
};

export function sessionsPaletteHint(menu: SessionsPaletteState["menu"]): string {
  return menu === "delete"
    ? "Enter delete · ← or Esc cancel"
    : "↑↓ navigate · → delete · Enter resume · Esc back";
}

export function selectedSession(state: SessionsPaletteState): SessionSummary | undefined {
  return state.sessions[state.index];
}

/** After a successful delete, stay in the sessions browser on the refreshed list. */
export function sessionsPaletteAfterDelete(
  sessions: SessionSummary[],
  previousIndex: number,
): SessionsPaletteState | null {
  if (sessions.length === 0) return null;
  return {
    phase: "sessions",
    index: Math.min(previousIndex, sessions.length - 1),
    sessions,
    menu: "list",
  };
}
