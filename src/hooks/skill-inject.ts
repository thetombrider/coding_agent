import { discoverSkills } from "../skills/discovery.js";
import { injectLeadingContext } from "../prompt/inject.js";
import { isRatelEnabled } from "../ratel/config.js";
import type { HookRegistry } from "./types.js";

/** Collapse control chars and strip angle brackets so skill metadata cannot break injected blocks. */
export function sanitizeSkillField(value: string): string {
  return value.replace(/[\r\n\t]/g, " ").replace(/[<>]/g, "").trim();
}

/**
 * Inject a compact skill index into every prompt so the agent knows which
 * skills are available without having to call skill_list first.
 * Only runs when at least one skill is discoverable.
 */
export function installSkillInject(hooks: HookRegistry): void {
  hooks.on("before_prompt", ({ messages }, ctx) => {
    if (isRatelEnabled()) return;

    const skills = discoverSkills(ctx.cwd);
    if (skills.length === 0) return;

    const entries = skills
      .map((s) => `  · ${sanitizeSkillField(s.name)}: ${sanitizeSkillField(s.description)}`)
      .join("\n");

    const block = `<available-skills>\n${entries}\n</available-skills>\n`
      + `Call skill_use with a skill name to load its full instructions.`;

    return { messages: injectLeadingContext(messages, block) };
  });
}
