import { readFileSync } from "node:fs";
import type { Skill } from "@ratel-ai/sdk";
import { discoverSkills, loadSkillContent } from "../skills/discovery.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function parseFrontmatterList(fm: string, key: string): string[] | undefined {
  const lines = fm.split("\n");
  const header = `${key}:`;
  const start = lines.findIndex((line) => line.trim() === header || line.startsWith(`${key}:`));
  if (start === -1) return undefined;

  const first = lines[start]!.trim();
  const inline = first.match(new RegExp(`^${key}:\\s*\\[(.+)]\\s*$`))?.[1];
  if (inline) {
    return inline.split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  }

  const items: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/^\s+-\s+/.test(line)) break;
    const item = line.match(/^\s+-\s+(.+)$/)?.[1]?.trim();
    if (item) items.push(item);
  }
  return items.length > 0 ? items : undefined;
}

function parseTags(fm: string): string[] | undefined {
  return parseFrontmatterList(fm, "tags");
}

/** Optional `tools:` frontmatter — tool ids this skill's playbook calls. */
function parseSkillTools(fm: string): string[] | undefined {
  return parseFrontmatterList(fm, "tools");
}

function readFrontmatter(path: string): string | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    return raw.match(FRONTMATTER_RE)?.[1];
  } catch {
    return undefined;
  }
}

/** Register all discoverable skills into a Ratel SkillCatalog. */
export function registerDiscoveredSkills(
  register: (skill: Skill) => void,
  cwd: string,
): number {
  let count = 0;
  for (const meta of discoverSkills(cwd)) {
    const content = loadSkillContent(meta.path);
    if (!content) continue;
    const fm = readFrontmatter(meta.path);
    register({
      id: meta.name,
      name: meta.name,
      description: meta.description,
      ...(fm && parseTags(fm) ? { tags: parseTags(fm) } : {}),
      ...(fm && parseSkillTools(fm) ? { tools: parseSkillTools(fm) } : {}),
      body: content.instructions,
    });
    count += 1;
  }
  return count;
}
