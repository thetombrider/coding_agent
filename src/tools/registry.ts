import { bashTool } from "./bash.js";
import { readTool } from "./read.js";
import type { Tool } from "./types.js";

export type AnyTool = Tool<any>;

export function getCoreTools(): AnyTool[] {
  return [readTool, bashTool];
}

export function pickTools(names: string[]): AnyTool[] {
  const all = getCoreTools();
  const set = new Set(names);
  return all.filter((t) => set.has(t.name));
}
