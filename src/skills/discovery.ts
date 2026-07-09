import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { findRepoRoot } from "../prompt/repo-root.js";
import type { SkillContent, SkillMeta, SkillScope } from "./types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

/**
 * Parse a YAML scalar value from frontmatter — handles both single-line values and
 * block scalars (`|` literal, `>` folded). Strips surrounding quotes from inline values.
 */
function parseYamlString(fm: string, key: string): string | undefined {
  const lines = fm.split("\n");
  const idx = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (idx === -1) return undefined;
  const afterColon = lines[idx]!.slice(key.length + 1).trim();
  // Block scalar indicators: | |- |+ > >- >+
  if (/^[|>][+-]?$/.test(afterColon)) {
    const isFolded = afterColon.startsWith(">");
    const bodyLines: string[] = [];
    for (let i = idx + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) break;
      bodyLines.push(line.trim());
    }
    const joined = bodyLines.join(isFolded ? " " : "\n").trim();
    return joined || undefined;
  }
  return afterColon.replace(/^['"]|['"]$/g, "") || undefined;
}

/** Parse the YAML frontmatter of a SKILL.md and return skill meta (or undefined if invalid). */
export function parseSkillMeta(content: string, filePath: string, dir: string): SkillMeta | undefined {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return undefined;
  const fm = m[1];
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = parseYamlString(fm, "description");
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
  const description = parseYamlString(fm, "description");
  if (!name || !description) return undefined;
  const version = fm.match(/^version:\s*(.+)$/m)?.[1]?.trim();
  const dir = dirname(filePath);
  return { name, description, version, path: filePath, dir, instructions: body };
}

/** User-global skill directories, scanned after all project-local tiers. */
function globalSkillDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".orin", "skills"),
    join(home, ".claude", "skills"),
    join(home, ".agents", "skills"),
  ];
}

/**
 * Discover all SKILL.md files from the standard search locations.
 *
 * Search order (first match for a given name wins):
 *   1. All `.orin/skills/` dirs from cwd up to repo root (nearest cwd wins within this tier)
 *   2. All `.claude/skills/` dirs from cwd up to repo root (cross-agent compat)
 *   3. ~/.orin/skills/, ~/.claude/skills/, ~/.agents/skills/ (user-global fallbacks)
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

  function walkSkillRoots(...segments: string[]): void {
    const stop = findRepoRoot(cwd);
    let dir = cwd;
    while (true) {
      scanDir(join(dir, ...segments));
      if (dir === stop) break;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // Tier 1: project-local .orin (all ancestor levels before any .claude scan)
  walkSkillRoots(".orin", "skills");
  // Tier 2: project-local .claude compat
  walkSkillRoots(".claude", "skills");
  // Tier 3: user-global fallbacks (Claude Code / AgentSkills hub installs land here)
  for (const dir of globalSkillDirs()) {
    scanDir(dir);
  }

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

/**
 * Classify where a skill lives, for display in the TUI palette.
 *
 *   - `global`  — anything under the user's home dir (`~/.orin`, `~/.claude`, `~/.agents`)
 *   - `claude`  — a project-local `.claude/skills/` (cross-agent compat tier)
 *   - `project` — a project-local `.orin/skills/`
 *
 * Derived from `SkillMeta.path`; home-dir installs win so a `~/.claude` skill
 * reads as `global` rather than `claude`.
 */
export function skillScope(meta: SkillMeta): SkillScope {
  const home = homedir();
  if (meta.path === home || meta.path.startsWith(home + sep)) return "global";
  if (meta.path.includes(`${sep}.claude${sep}`)) return "claude";
  return "project";
}
