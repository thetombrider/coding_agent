/**
 * User-facing workspace isolation copy for settings menus and /settings CLI.
 * Describes effective runtime behavior, not just persisted config keys.
 */

import type { IsolationMode } from "./isolation.js";
import type { SessionIsolationMode } from "./session-isolation.js";

export const PARALLEL_SUBAGENT_MENU_VALUE = "worktree per child (fixed)";

export const PARALLEL_SUBAGENT_INFO =
  "Parallel task_parallel children each run in their own git worktree on "
  + "orin/subagent-* branches. This is fixed — mutating siblings cannot share one tree.";

export const SERIAL_SUBAGENT_SESSION_INFO =
  "While the parent runs on a session branch, serial task subagents co-edit that "
  + "branch — not a separate worktree. Your stored isolation floor still applies "
  + "when you switch the parent back to the host tree.";

/** Short value shown on the main settings row for serial task subagents. */
export function effectiveSerialSubagentMenuValue(
  sessionIsolation: SessionIsolationMode | undefined,
  floor: IsolationMode,
): string {
  if (sessionIsolation === "worktree") {
    if (floor !== "shared") {
      return `co-edit session branch (floor ${floor} on host tree)`;
    }
    return "co-edit session branch";
  }
  return `floor: ${floor}`;
}

/** Short value shown on the main settings row for the parent workspace. */
export function parentWorkspaceMenuValue(
  sessionIsolation: SessionIsolationMode | undefined,
  branch: string | undefined,
  cwd: string,
): string {
  if (sessionIsolation === "worktree" && branch) {
    return `session branch · ${branch}`;
  }
  const home = process.env.HOME;
  const short = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  return `host tree · ${short}`;
}

/** Header line for the serial subagent isolation sub-palette (host-tree mode). */
export function serialSubagentPaletteHeader(sessionIsolation: SessionIsolationMode | undefined): string {
  if (sessionIsolation === "worktree") {
    return SERIAL_SUBAGENT_SESSION_INFO;
  }
  return "Minimum isolation for serial task subagents — model may escalate, never go below this";
}

/** Status hint after enabling session-branch parent mode. */
export function sessionWorktreeEnableHint(branch: string | undefined): string {
  return branch
    ? `Parent → session branch ${branch} · serial subagents co-edit this branch`
    : "Parent → session branch · serial subagents co-edit this branch";
}

/** Multi-line workspace summary for /settings with no subcommand. */
export function workspaceSettingsOverview(input: {
  sessionIsolation: SessionIsolationMode | undefined;
  sessionBranch?: string;
  cwd: string;
  subagentFloor: IsolationMode;
}): string {
  const parent = parentWorkspaceMenuValue(input.sessionIsolation, input.sessionBranch, input.cwd);
  const serial = effectiveSerialSubagentMenuValue(input.sessionIsolation, input.subagentFloor);
  return (
    "Workspace\n"
    + `  parent (task loop):     ${parent}\n`
    + `  serial task:            ${serial}\n`
    + `  parallel task_parallel: ${PARALLEL_SUBAGENT_MENU_VALUE}\n`
    + "\n"
    + "/settings session-isolation · /settings isolation"
  );
}
