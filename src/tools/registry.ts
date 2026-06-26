import { askUserTool } from "./askuser.js";
import { bashTool } from "./bash.js";
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
import { writeTool } from "./write.js";
import type { Tool } from "./types.js";

export type AnyTool = Tool<any>;

const ALL_TOOLS: AnyTool[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  grepTool,
  findTool,
  lsTool,
  fetchTool,
  webSearchTool,
  searchSymbolsTool,
  fileOpTool,
  delegateReadTool,
  todowriteTool,
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
 * don't plan (`todowrite`), spawn further subagents (`task`/`task_parallel`),
 * batch file mutations (`file_op`), or interrupt the user (`askuser`). `fetch`
 * and `web_search` are read-only, so they stay.
 */
const CHILD_EXCLUDED = new Set([
  "todowrite",
  "task",
  "task_parallel",
  "file_op",
  "askuser",
  "skill_write",
]);

export function getCoreTools(): AnyTool[] {
  return [...ALL_TOOLS];
}

/** Tool preset for subagent child loops (excludes planning tools). */
export function getChildTools(): AnyTool[] {
  return ALL_TOOLS.filter((t) => !CHILD_EXCLUDED.has(t.name));
}

export function pickTools(names: string[]): AnyTool[] {
  const set = new Set(names);
  return ALL_TOOLS.filter((t) => set.has(t.name));
}
