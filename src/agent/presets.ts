import { getChildTools, pickTools } from "../tools/registry.js";
import type { AnyTool } from "../tools/registry.js";

export type AgentPreset = "explore" | "review" | "implement";
export type IsolationMode = "shared" | "worktree" | "sandbox";

export interface PresetDefinition {
  agent: AgentPreset;
  system: string;
  tools: AnyTool[];
  mutating: boolean;
  defaultIsolation: IsolationMode;
}

export const EXPLORE_SYSTEM = (
  "You are an explore subagent. Investigate the codebase and report findings "
  + "concisely. Use read-only tools (read, grep, find, ls) — never mutate files "
  + "or run shell commands. Return a clear summary of what you found."
);

export const REVIEW_SYSTEM = (
  "You are a review subagent. Examine code or diffs and return actionable findings "
  + "(bugs, style issues, missing tests). Use read-only tools only — never mutate "
  + "files or run shell commands. Be concise and specific."
);

export const IMPLEMENT_SYSTEM = (
  "You are an implementation subagent. Carry out the assigned coding task using the "
  + "tools available to you — read, edit, and run code as needed — then summarize what "
  + "you changed and the outcome. Keep the summary focused on results the parent agent needs."
);

const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

export function resolvePreset(agent: AgentPreset = "implement"): PresetDefinition {
  switch (agent) {
    case "explore":
      return {
        agent: "explore",
        system: EXPLORE_SYSTEM,
        tools: pickTools([...READ_ONLY_TOOL_NAMES]),
        mutating: false,
        defaultIsolation: "shared",
      };
    case "review":
      return {
        agent: "review",
        system: REVIEW_SYSTEM,
        tools: pickTools([...READ_ONLY_TOOL_NAMES]),
        mutating: false,
        defaultIsolation: "shared",
      };
    case "implement":
      return {
        agent: "implement",
        system: IMPLEMENT_SYSTEM,
        tools: getChildTools(),
        mutating: true,
        defaultIsolation: "shared",
      };
  }
}
