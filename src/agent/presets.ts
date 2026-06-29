import { getChildTools, pickTools } from "../tools/registry.js";
import type { AnyTool } from "../tools/registry.js";
import { formatRemindersBlock } from "../todos/store.js";
import type { TodoItem } from "../todos/types.js";
import type { IsolationMode } from "./isolation.js";

export type { IsolationMode } from "./isolation.js";
export type AgentPreset = "explore" | "review" | "implement";

export interface PresetDefinition {
  agent: AgentPreset;
  system: string;
  tools: AnyTool[];
  mutating: boolean;
  defaultIsolation: IsolationMode;
}

export const EXPLORE_SYSTEM = (
  "You are an explore subagent. Investigate the codebase and report findings "
  + "concisely. Use read-only tools (read, grep, find, ls, search_symbols) — never mutate files "
  + "or run shell commands. Return a clear summary of what you found."
);

export const REVIEW_SYSTEM = (
  "You are a review subagent. Examine code or diffs and return actionable findings "
  + "(bugs, style issues, missing tests). Use read-only tools only (read, grep, find, ls, search_symbols) — never mutate "
  + "files or run shell commands. Be concise and specific."
);

export const IMPLEMENT_SYSTEM = (
  "You are an implementation subagent. Carry out the assigned coding task using the "
  + "tools available to you — read, edit, and run code as needed — then summarize what "
  + "you changed and the outcome. Keep the summary focused on results the parent agent needs."
);

const PARENT_PLAN_INSTRUCTIONS = (
  "\n\nIf your work surfaces new requirements (missing dependencies, follow-up steps, "
  + "blockers the parent should track), call `propose_todo` with a full replacement list "
  + "for the parent. The parent owns the session plan; your proposal is applied "
  + "as-is on its next turn. Skip propose_todo for trivial work or when the existing "
  + "parent list still tracks reality."
);

/**
 * Prepend the parent's current task list to a preset's system prompt so the
 * subagent can build a coherent proposal. Empty parent list ⇒ no augmentation.
 */
export function augmentSystemWithParentTodos(
  base: string,
  parentTodos: TodoItem[] | undefined,
): string {
  if (!parentTodos || parentTodos.length === 0) {
    return base + PARENT_PLAN_INSTRUCTIONS;
  }
  return `${base}\n\nPARENT PLAN (read-only; you may replace it via propose_todo):\n${formatRemindersBlock(parentTodos)}${PARENT_PLAN_INSTRUCTIONS}`;
}

const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls", "search_symbols"] as const;

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
