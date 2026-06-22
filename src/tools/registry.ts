import { bashTool } from "./bash.js";
import { delegateReadTool } from "./delegate-read.js";
import { editTool } from "./edit.js";
import { fetchTool } from "./fetch.js";
import { fileOpTool } from "./file-op.js";
import { findTool } from "./find.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { readTool } from "./read.js";
import { taskTool } from "./task.js";
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
  fileOpTool,
  delegateReadTool,
  todowriteTool,
  taskTool,
];

/** Tools excluded from subagent child loops — parent owns the plan; no recursion in v1. */
const CHILD_EXCLUDED = new Set(["todowrite", "task", "file_op"]);

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
