import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { discoverSkills, globalSkillsDir, resolveSkill } from "../skills/discovery.js";
import type { AgentContext } from "../types.js";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

// ─── skill_list ──────────────────────────────────────────────────────────────

const skillListSchema = z.object({});

export const skillListTool: Tool<z.infer<typeof skillListSchema>> = {
  name: "skill_list",
  description: loadToolDescription("skill_list"),
  schema: skillListSchema,
  async execute(_args, ctx: AgentContext) {
    const skills = discoverSkills(ctx.cwd);
    if (skills.length === 0) {
      return { output: "No skills found. Use skill_write to create one." };
    }
    const lines = skills.map((s) => {
      const ver = s.version ? ` (v${s.version})` : "";
      return `• ${s.name}${ver}: ${s.description}`;
    });
    return { output: `Available skills (${skills.length}):\n${lines.join("\n")}` };
  },
};

// ─── skill_use ───────────────────────────────────────────────────────────────

const skillUseSchema = z.object({
  name: z.string().describe("Skill name to load (as shown in skill_list)."),
  file: z
    .string()
    .optional()
    .describe(
      "Optional relative path to a supporting file inside the skill directory "
      + "(e.g. 'references/api.md'). Omit to load the main SKILL.md instructions.",
    ),
});

export const skillUseTool: Tool<z.infer<typeof skillUseSchema>> = {
  name: "skill_use",
  description: loadToolDescription("skill_use"),
  schema: skillUseSchema,
  async execute({ name, file }, ctx: AgentContext) {
    const skill = resolveSkill(name, ctx.cwd);
    if (!skill) {
      const all = discoverSkills(ctx.cwd).map((s) => s.name);
      const hint = all.length > 0 ? `\nKnown skills: ${all.join(", ")}` : "";
      return { output: `Skill '${name}' not found.${hint}`, isError: true };
    }

    if (file) {
      // Load a supporting file from the skill directory
      const safePath = join(skill.dir, file);
      // Prevent path traversal: resolved path must stay inside skill dir
      if (!safePath.startsWith(skill.dir + "/") && safePath !== skill.dir) {
        return { output: "Path traversal rejected.", isError: true };
      }
      if (!existsSync(safePath)) {
        return { output: `File '${file}' not found in skill '${name}'.`, isError: true };
      }
      let content: string;
      try {
        content = readFileSync(safePath, "utf8");
      } catch (err) {
        return { output: `Could not read '${file}': ${String(err)}`, isError: true };
      }
      return { output: `[Skill: ${name} / ${file}]\n\n${content}` };
    }

    return {
      output: `[Skill: ${skill.name}${skill.version ? ` v${skill.version}` : ""}]\n\n${skill.instructions}`,
    };
  },
};

// ─── skill_write ─────────────────────────────────────────────────────────────

const skillWriteSchema = z.object({
  action: z.enum(["create", "update", "delete"]).describe(
    "create: write a new skill. update: replace an existing skill's SKILL.md. delete: remove a skill.",
  ),
  name: z.string().regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with hyphens.").describe(
    "Skill identifier (lowercase, hyphens only, e.g. 'git-workflow').",
  ),
  description: z
    .string()
    .optional()
    .describe("One-line description of when to use this skill. Required for create/update."),
  instructions: z
    .string()
    .optional()
    .describe(
      "Markdown body with the skill's step-by-step instructions. Required for create/update. "
      + "Describe the procedure clearly so any agent can follow it without prior context.",
    ),
  version: z.string().optional().describe("Optional semantic version string (e.g. '1.0.0')."),
  scope: z
    .enum(["global", "project"])
    .optional()
    .describe(
      "Where to save the skill. global (default): ~/.orin/skills/<name>/SKILL.md — persists across projects. "
      + "project: .orin/skills/<name>/SKILL.md in the repo root — committed with the project.",
    ),
});

export const skillWriteTool: Tool<z.infer<typeof skillWriteSchema>> = {
  name: "skill_write",
  description: loadToolDescription("skill_write"),
  schema: skillWriteSchema,
  needsApproval: () => true,
  async execute({ action, name, description, instructions, version, scope }, ctx: AgentContext) {
    if (action === "delete") {
      const skill = resolveSkill(name, ctx.cwd);
      if (!skill) return { output: `Skill '${name}' not found — nothing to delete.`, isError: true };
      try {
        unlinkSync(skill.path);
      } catch (err) {
        return { output: `Could not delete skill '${name}': ${String(err)}`, isError: true };
      }
      return { output: `Skill '${name}' deleted (${skill.path}).` };
    }

    if (!description?.trim()) {
      return { output: "description is required for create/update.", isError: true };
    }
    if (!instructions?.trim()) {
      return { output: "instructions is required for create/update.", isError: true };
    }

    let baseDir: string;
    if (scope === "project") {
      const { findRepoRoot } = await import("../prompt/repo-root.js");
      const root = findRepoRoot(ctx.cwd) ?? ctx.cwd;
      baseDir = join(root, ".orin", "skills");
    } else {
      baseDir = globalSkillsDir();
    }

    const skillDir = join(baseDir, name);
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");

    const verLine = version ? `\nversion: ${version}` : "";
    const content = `---\nname: ${name}\ndescription: ${description.trim()}${verLine}\n---\n\n${instructions.trim()}\n`;

    try {
      writeFileSync(skillPath, content, "utf8");
    } catch (err) {
      return { output: `Could not write skill: ${String(err)}`, isError: true };
    }

    const verb = action === "create" ? "Created" : "Updated";
    return {
      output: `${verb} skill '${name}' at ${skillPath}\n\nUse skill_use to load it into context.`,
    };
  },
};
