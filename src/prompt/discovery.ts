import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { findRepoRoot } from "./repo-root.js";

export interface DiscoveredFile {
  path: string;
  content: string;
}

function readIfExists(path: string): DiscoveredFile | undefined {
  if (!existsSync(path)) return undefined;
  return { path, content: readFileSync(path, "utf8").trim() };
}

/** Walk from `cwd` up to the repo root (or filesystem root) collecting `AGENTS.md` files. */
export function discoverAgentsFiles(cwd: string): DiscoveredFile[] {
  const found: DiscoveredFile[] = [];
  const seen = new Set<string>();
  const stopAt = findRepoRoot(cwd) ?? parseStopRoot(cwd);

  let dir = cwd;
  while (true) {
    const file = readIfExists(join(dir, "AGENTS.md"));
    if (file && !seen.has(file.path)) {
      seen.add(file.path);
      found.push(file);
    }
    if (dir === stopAt) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const globalPath = join(homedir(), ".orin", "AGENTS.md");
  const global = readIfExists(globalPath);
  if (global && !seen.has(global.path)) found.unshift(global);

  return found.reverse();
}

/** Closest `SYSTEM.md` walking from `cwd` up to the repo root. */
export function discoverSystemFile(cwd: string): DiscoveredFile | undefined {
  const stopAt = findRepoRoot(cwd) ?? parseStopRoot(cwd);

  let dir = cwd;
  while (true) {
    const file = readIfExists(join(dir, "SYSTEM.md"));
    if (file) return file;
    if (dir === stopAt) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function parseStopRoot(cwd: string): string {
  let dir = cwd;
  while (true) {
    const parent = dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}
