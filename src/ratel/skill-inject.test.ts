import { describe, expect, it } from "vitest";
import { createHookRegistry } from "../hooks/registry.js";
import { installSkillInject } from "../hooks/skill-inject.js";
import { testAgentContext } from "../test-helpers.js";
import { __testClearCache, saveConfig } from "../config/config.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("installSkillInject with Ratel", () => {
  it("skips flat skill index when ratel.enabled is true", async () => {
    const prevHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "orin-ratel-test-"));
    process.env.HOME = home;

    const skillDir = join(home, ".orin", "skills", "demo");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: demo\ndescription: A demo skill\n---\n\nDo the thing.\n",
    );

    saveConfig({ ratel: { enabled: true } });
    __testClearCache();

    const hooks = createHookRegistry();
    installSkillInject(hooks);
    const ctx = testAgentContext(home, [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);

    try {
      const result = await hooks.fireHook(
        "before_prompt",
        { messages: ctx.messages, model: "faux:test" },
        ctx,
      );
      expect(result).toBeUndefined();
    } finally {
      process.env.HOME = prevHome;
      __testClearCache();
    }
  });
});
