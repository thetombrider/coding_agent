import { bashTool } from "./bash.js";
import { delegateReadTool } from "./delegate-read.js";
import { editTool } from "./edit.js";
import { findTool } from "./find.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { readTool } from "./read.js";
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
  delegateReadTool,
  todowriteTool,
];

/** Tools excluded from subagent child loops — parent owns the plan. */
const CHILD_EXCLUDED = new Set(["todowrite"]);

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
