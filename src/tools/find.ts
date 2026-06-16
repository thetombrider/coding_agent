import { relative } from "node:path";
import { z } from "zod";
import { resolvePath } from "../util/paths.js";
import { loadToolDescription } from "../util/load-txt.js";
import type { Workspace } from "../workspace/types.js";
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

async function walkWorkspace(
  workspace: Workspace,
  dir: string,
  root: string,
  re: RegExp,
  results: string[],
): Promise<void> {
  let names: string[];
  try {
    names = await workspace.list(dir);
  } catch {
    return;
  }

  for (const name of names) {
    if (name === "node_modules" || name === ".git") continue;
    const full = dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
    const rel = relative(root, full) || name;

    let childNames: string[] | null = null;
    try {
      childNames = await workspace.list(full);
    } catch {
      childNames = null;
    }

    if (childNames !== null) {
      await walkWorkspace(workspace, full, root, re, results);
    } else if (re.test(rel)) {
      results.push(rel);
    }
  }
}

export async function findMatchingFiles(
  workspace: Workspace,
  root: string,
  pattern: string,
): Promise<string[]> {
  const re = globToRegExp(pattern);
  const results: string[] = [];
  await walkWorkspace(workspace, root, root, re, results);
  results.sort();
  return results;
}

export const findTool: Tool<FindArgs> = {
  name: "find",
  description: loadToolDescription("find"),
  schema,
  async execute({ pattern, path }, ctx) {
    const root = resolvePath(ctx.cwd, path ?? ".");
    const results = await findMatchingFiles(ctx.workspace, root, pattern);
    return { output: results.length ? results.join("\n") : "(no matches)" };
  },
};
