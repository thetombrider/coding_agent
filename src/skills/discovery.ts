import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { findRepoRoot } from "../prompt/repo-root.js";
import type { SkillContent, SkillMeta } from "./types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

/** Parse the YAML frontmatter of a SKILL.md and return skill meta (or undefined if invalid). */
export function parseSkillMeta(content: string, filePath: string, dir: string): SkillMeta | undefined {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return undefined;
  const fm = m[1];
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name || !description) return undefined;
  const version = fm.match(/^version:\s*(.+)$/m)?.[1]?.trim();
  return { name, description, version, path: filePath, dir };
}

/** Load a SKILL.md file and return full content including the instruction body. */
export function loadSkillContent(filePath: string): SkillContent | undefined {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return undefined;
  const fm = m[1];
  const body = (m[2] ?? "").trim();
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name || !description) return undefined;
  const version = fm.match(/^version:\s*(.+)$/m)?.[1]?.trim();
  const dir = dirname(filePath);
  return { name, description, version, path: filePath, dir, instructions: body };
}

/**
 * Discover all SKILL.md files from the standard search locations.
 *
 * Search order (first match for a given name wins):
 *   1. <cwd>/.orin/skills/  and ancestors up to repo root
 *   2. <cwd>/.claude/skills/ and ancestors (cross-agent compat)
 *   3. ~/.orin/skills/  (user-global)
 */
export function discoverSkills(cwd: string): SkillMeta[] {
  const seen = new Map<string, SkillMeta>(); // name → first found (highest priority)

  function scanDir(base: string): void {
    if (!existsSync(base)) return;
    let entries: string[];
    try {
      entries = readdirSync(base);
    } catch {
      return;
    }
    for (const entry of entries) {
      const dir = join(base, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const skillFile = join(dir, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      let raw: string;
      try {
        raw = readFileSync(skillFile, "utf8");
      } catch {
        continue;
      }
      const meta = parseSkillMeta(raw, skillFile, dir);
      if (!meta) continue;
      if (!seen.has(meta.name)) seen.set(meta.name, meta);
    }
  }

  // Walk from cwd up to repo root, checking .orin/skills and .claude/skills
  const stop = findRepoRoot(cwd);
  let dir = cwd;
  while (true) {
    scanDir(join(dir, ".orin", "skills"));
    scanDir(join(dir, ".claude", "skills"));
    if (dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // User-global fallback
  scanDir(join(homedir(), ".orin", "skills"));

  return [...seen.values()];
}

/** Resolve a skill by name and return its full content. Returns undefined if not found. */
export function resolveSkill(name: string, cwd: string): SkillContent | undefined {
  const skills = discoverSkills(cwd);
  const meta = skills.find((s) => s.name === name);
  if (!meta) return undefined;
  return loadSkillContent(meta.path);
}

/** Global skills directory (user-level, where skill_write saves by default). */
export function globalSkillsDir(): string {
  return join(homedir(), ".orin", "skills");
}
