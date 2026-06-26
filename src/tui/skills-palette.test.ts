import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SkillMeta } from "../skills/types.js";
import {
  selectedSkill,
  skillInvocationMessage,
  skillPrefill,
  skillScopeLabel,
  skillsPaletteHint,
} from "./skills-palette.js";

function meta(name: string, path: string): SkillMeta {
  return { name, description: `${name} desc`, path, dir: path.replace(/\/SKILL\.md$/, "") };
}

describe("skillsPaletteHint", () => {
  it("describes list navigation", () => {
    expect(skillsPaletteHint("list")).toContain("→ or Enter details");
    expect(skillsPaletteHint("list")).toContain("Esc back");
  });

  it("describes the detail view controls", () => {
    expect(skillsPaletteHint("detail")).toContain("Enter prefill /skill");
    expect(skillsPaletteHint("detail")).toContain("back to list");
  });
});

describe("selectedSkill", () => {
  it("returns the skill at the current index", () => {
    const skills = [meta("a", "/repo/.orin/skills/a/SKILL.md"), meta("b", "/repo/.orin/skills/b/SKILL.md")];
    expect(selectedSkill({ phase: "skills", index: 1, skills, menu: "list" })?.name).toBe("b");
    expect(selectedSkill({ phase: "skills", index: 5, skills, menu: "list" })).toBeUndefined();
  });
});

describe("skillScopeLabel", () => {
  it("labels a project-local .orin skill as project", () => {
    expect(skillScopeLabel(meta("a", "/work/repo/.orin/skills/a/SKILL.md"))).toBe("project");
  });

  it("labels a project-local .claude skill as claude", () => {
    expect(skillScopeLabel(meta("a", "/work/repo/.claude/skills/a/SKILL.md"))).toBe("claude");
  });

  it("labels a home-dir install as global", () => {
    const path = join(homedir(), ".claude", "skills", "a", "SKILL.md");
    expect(skillScopeLabel(meta("a", path))).toBe("global");
  });
});

describe("skillPrefill", () => {
  it("prefills the /skill command with a trailing space for the task", () => {
    expect(skillPrefill("git-workflow")).toBe("/skill git-workflow ");
  });
});

describe("skillInvocationMessage", () => {
  it("asks the agent to use the skill when no task is given", () => {
    expect(skillInvocationMessage("git-workflow")).toBe("Use the `git-workflow` skill.");
  });

  it("appends the task when provided", () => {
    expect(skillInvocationMessage("git-workflow", "open a PR")).toBe(
      "Use the `git-workflow` skill. open a PR",
    );
  });

  it("ignores blank tasks", () => {
    expect(skillInvocationMessage("git-workflow", "   ")).toBe("Use the `git-workflow` skill.");
  });
});
