import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import { resolvePath } from "../util/paths.js";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

const schema = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "**/*.ts" or "src/**/*.test.ts"'),
  path: z.string().optional().describe("Root directory to search from (default: workspace root)"),
});

export type FindArgs = z.infer<typeof schema>;

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

async function walk(
  dir: string,
  root: string,
  re: RegExp,
  results: string[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    const rel = relative(root, full) || entry.name;
    if (entry.isDirectory()) {
      await walk(full, root, re, results);
    } else if (re.test(rel)) {
      results.push(rel);
    }
  }
}

export async function findMatchingFiles(root: string, pattern: string): Promise<string[]> {
  const re = globToRegExp(pattern);
  const results: string[] = [];
  await walk(root, root, re, results);
  results.sort();
  return results;
}

export const findTool: Tool<FindArgs> = {
  name: "find",
  description: loadToolDescription("find"),
  schema,
  async execute({ pattern, path }, ctx) {
    const root = resolvePath(ctx.cwd, path ?? ".");
    const results = await findMatchingFiles(root, pattern);
    return { output: results.length ? results.join("\n") : "(no matches)" };
  },
};
