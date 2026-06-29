import { askUserTool } from "./askuser.js";
import { bashTool } from "./bash.js";
import { bashKillTool } from "./bash-kill.js";
import { bashStatusTool } from "./bash-status.js";
import { delegateReadTool } from "./delegate-read.js";
import { editTool } from "./edit.js";
import { fetchTool } from "./fetch.js";
import { webSearchTool } from "./web-search.js";
import { fileOpTool } from "./file-op.js";
import { findTool } from "./find.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { searchSymbolsTool } from "./search-symbols.js";
import { readTool } from "./read.js";
import { skillListTool, skillUseTool, skillWriteTool } from "./skill.js";
import { taskParallelTool, taskTool } from "./task.js";
import { todowriteTool } from "./todowrite.js";
import { proposeTodoTool } from "./propose-todo.js";
import { writeTool } from "./write.js";
import type { Tool } from "./types.js";

export type AnyTool = Tool<any>;

const ALL_TOOLS: AnyTool[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  bashStatusTool,
  bashKillTool,
  grepTool,
  findTool,
  lsTool,
  fetchTool,
  webSearchTool,
  searchSymbolsTool,
  fileOpTool,
  delegateReadTool,
  todowriteTool,
  proposeTodoTool,
  taskTool,
  taskParallelTool,
  askUserTool,
  skillListTool,
  skillUseTool,
  skillWriteTool,
];

/**
 * Tools excluded from subagent child loops — the parent owns the plan, the
 * mutating file ops, and the user dialogue (no recursion in v1), so subagents
 * don't write to the session task list (`todowrite`), spawn further subagents
 * (`task`/`task_parallel`), batch file mutations (`file_op`), or interrupt the
 * user (`askuser`). `propose_todo` is the *child-facing* counterpart that
 * pushes a replacement list up to the parent (issue #149) — the child's own
 * `ctx.todos` is never mutated, so plan authority stays on the parent side.
 * `fetch` and `web_search` are read-only, so they stay.
 */
const CHILD_EXCLUDED = new Set([
  "todowrite",
  "task",
  "task_parallel",
  "file_op",
  "askuser",
  "skill_write",
]);

/**
 * Tools that are only meaningful inside a subagent. The parent already owns
 * the plan via `todowrite`; `propose_todo` would just be a noisier alias there.
 * Kept out of `getCoreTools` so the parent's tool catalog stays clean and the
 * `propose_todo` hook never accidentally fires for a parent-loop call.
 */
const CHILD_ONLY = new Set([
  "propose_todo",
]);

export function getCoreTools(): AnyTool[] {
  return ALL_TOOLS.filter((t) => !CHILD_ONLY.has(t.name));
}

/** Tool preset for subagent child loops (excludes the parent's planning tool, recursion, and user-dialogue; keeps child-only tools). */
export function getChildTools(): AnyTool[] {
  return ALL_TOOLS.filter(
    (t) => CHILD_ONLY.has(t.name) || !CHILD_EXCLUDED.has(t.name),
  );
}

export function pickTools(names: string[]): AnyTool[] {
  const set = new Set(names);
  return ALL_TOOLS.filter((t) => set.has(t.name));
}
