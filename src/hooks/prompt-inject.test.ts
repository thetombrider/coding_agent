import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createHookRegistry } from "./registry.js";
import { installPromptInject } from "./prompt-inject.js";
import { testAgentContext } from "../test-helpers.js";

describe("installPromptInject", () => {
  it("injects environment and AGENTS.md into before_prompt messages", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "prompt-inject-"));
    await writeFile(join(cwd, "AGENTS.md"), "Use bun for scripts.");

    const hooks = createHookRegistry();
    installPromptInject(hooks);
    const ctx = testAgentContext(cwd, [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);

    const result = await hooks.fireHook(
      "before_prompt",
      { messages: ctx.messages, model: "anthropic/claude-sonnet-4.6" },
      ctx,
    );

    const injected = result && "messages" in result ? result.messages[0] : undefined;
    const text = injected?.content[0].type === "text" ? injected.content[0].text : "";
    expect(text).toContain("<environment>");
    expect(text).toContain(`cwd: ${cwd}`);
    expect(text).toContain("model: anthropic/claude-sonnet-4.6");
    expect(text).toContain('<project_instructions path="');
    expect(text).toContain("Use bun for scripts.");
  });
});
