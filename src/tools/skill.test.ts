import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { skillUseTool, skillWriteTool } from "./skill.js";
import { testAgentContext } from "../test-helpers.js";

describe("skill tools", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "orin-skill-tool-")));
    execSync("git init -q", { cwd: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("skill_write create fails when the skill already exists", async () => {
    const ctx = testAgentContext(root);
    const args = {
      action: "create" as const,
      name: "deploy",
      description: "Deploy the app",
      instructions: "Step 1",
      scope: "project" as const,
    };

    const signal = new AbortController().signal;
    const first = await skillWriteTool.execute(args, ctx, signal);
    expect(first.isError).toBeFalsy();

    const second = await skillWriteTool.execute(args, ctx, signal);
    expect(second.isError).toBe(true);
    expect(second.output).toContain("already exists");
  });

  it("skill_write update fails when the skill does not exist", async () => {
    const ctx = testAgentContext(root);
    const result = await skillWriteTool.execute(
      {
        action: "update",
        name: "missing",
        description: "Deploy the app",
        instructions: "Step 1",
        scope: "project",
      },
      ctx,
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not found");
  });

  it("skill_use rejects path traversal via symlinks", async () => {
    const skillDir = join(root, ".orin", "skills", "demo");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: demo\ndescription: demo skill\n---\n\nbody\n",
      "utf8",
    );
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "top secret", "utf8");
    symlinkSync(secret, join(skillDir, "escape.md"));

    const ctx = testAgentContext(root);
    const result = await skillUseTool.execute(
      { name: "demo", file: "escape.md" },
      ctx,
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Path traversal rejected");
  });
});
