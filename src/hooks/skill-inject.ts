import { discoverSkills } from "../skills/discovery.js";
import { injectLeadingContext } from "../prompt/inject.js";
import type { HookRegistry } from "./types.js";

/**
 * Inject a compact skill index into every prompt so the agent knows which
 * skills are available without having to call skill_list first.
 * Only runs when at least one skill is discoverable.
 */
export function installSkillInject(hooks: HookRegistry): void {
  hooks.on("before_prompt", ({ messages }, ctx) => {
    const skills = discoverSkills(ctx.cwd);
    if (skills.length === 0) return;

    const entries = skills
      .map((s) => `  • ${s.name}: ${s.description}`)
      .join("\n");

    const block = `<available-skills>\n${entries}\n</available-skills>\n`
      + `Call skill_use with a skill name to load its full instructions.`;

    return { messages: injectLeadingContext(messages, block) };
  });
}
