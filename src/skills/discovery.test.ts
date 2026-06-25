import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkills } from "./discovery.js";

function writeSkill(dir: string, name: string, description: string): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`,
    "utf8",
  );
}

describe("discoverSkills", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "orin-skills-disc-")));
    execSync("git init -q", { cwd: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("prefers .orin over .claude at the same directory level", () => {
    writeSkill(join(root, ".orin", "skills"), "deploy", "orin deploy");
    writeSkill(join(root, ".claude", "skills"), "deploy", "claude deploy");

    const skills = discoverSkills(root);
    expect(skills.find((s) => s.name === "deploy")?.description).toBe("orin deploy");
  });

  it("scans all .orin levels before any .claude level", () => {
    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    writeSkill(join(root, ".claude", "skills"), "shared", "root claude");
    writeSkill(join(nested, ".orin", "skills"), "shared", "nested orin");

    const skills = discoverSkills(nested);
    expect(skills.find((s) => s.name === "shared")?.description).toBe("nested orin");
  });
});
