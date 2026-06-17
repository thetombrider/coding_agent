import { getChildTools, pickTools } from "../tools/registry.js";
import type { AnyTool } from "../tools/registry.js";

export type AgentPreset = "explore" | "review" | "general";
export type IsolationMode = "shared" | "sandbox";

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

export const GENERAL_SYSTEM = (
  "You are a general-purpose subagent. Complete the assigned task using the tools "
  + "available to you, then summarize what you did and the outcome. Keep the summary "
  + "focused on results the parent agent needs."
);

const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

export function resolvePreset(agent: AgentPreset = "general"): PresetDefinition {
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
    case "general":
      return {
        agent: "general",
        system: GENERAL_SYSTEM,
        tools: getChildTools(),
        mutating: true,
        defaultIsolation: "sandbox",
      };
  }
}
