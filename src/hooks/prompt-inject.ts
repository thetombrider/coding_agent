import { discoverAgentsFiles } from "../prompt/discovery.js";
import { currentEnvironmentInfo, formatEnvironmentBlock } from "../prompt/environment.js";
import { buildPromptInjectionBlocks, injectLeadingContext } from "../prompt/inject.js";
import { formatProjectInstructions } from "../prompt/instructions.js";
import type { HookRegistry } from "./types.js";

export function installPromptInject(hooks: HookRegistry): void {
  hooks.on("before_prompt", ({ messages, model }, ctx) => {
    const env = formatEnvironmentBlock(currentEnvironmentInfo(ctx.cwd, model));
    const instructions = formatProjectInstructions(discoverAgentsFiles(ctx.cwd));
    const block = buildPromptInjectionBlocks([env, instructions]);
    if (!block) return;
    return { messages: injectLeadingContext(messages, block) };
  });
}
