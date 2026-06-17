import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

/** Git repo root when available, otherwise the nearest ancestor with a `.git` directory. */
export function findRepoRoot(startDir: string): string | undefined {
  try {
    const out = execSync("git rev-parse --show-toplevel", {
      cwd: startDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) return out;
  } catch {
    // not inside a git work tree
  }

  let dir = startDir;
  const root = parse(startDir).root;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}
