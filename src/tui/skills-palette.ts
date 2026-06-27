import { skillScope } from "../skills/discovery.js";
import type { SkillMeta, SkillScope } from "../skills/types.js";

export type SkillsPaletteState = {
  phase: "skills";
  index: number;
  skills: SkillMeta[];
  menu: "list" | "detail";
};

export function skillsPaletteHint(menu: SkillsPaletteState["menu"]): string {
  return menu === "detail"
    ? "Enter prefill /skill · ← or Esc back to list"
    : "↑↓ navigate · → or Enter details · Esc back";
}

export function selectedSkill(state: SkillsPaletteState): SkillMeta | undefined {
  return state.skills[state.index];
}

/** Scope label shown per row in the palette (`project` | `global` | `claude`). */
export function skillScopeLabel(meta: SkillMeta): SkillScope {
  return skillScope(meta);
}

/**
 * Text prefilled into the input when a skill is picked from the palette. The
 * trailing space lets the user append a task before submitting, and submitting
 * runs through the same `/skill` command path as a typed invocation.
 */
export function skillPrefill(name: string): string {
  return `/skill ${name} `;
}

/**
 * The user-turn message a `/skill <name> [task]` invocation submits. Keeps a
 * single code path: the palette and the typed command both produce this string,
 * which the agent then acts on by loading the skill.
 */
export function skillInvocationMessage(name: string, task?: string): string {
  const trimmed = task?.trim();
  return trimmed ? `Use the \`${name}\` skill. ${trimmed}` : `Use the \`${name}\` skill.`;
}
