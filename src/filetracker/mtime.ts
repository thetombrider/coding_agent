import { stat as fsStat } from "node:fs/promises";
import { resolvePath } from "../util/paths.js";
import type { AgentContext } from "../types.js";

/** Return file mtime in milliseconds, or null if the path is missing or unreadable. */
export async function getFileMtimeMs(ctx: AgentContext, path: string): Promise<number | null> {
  const fullPath = resolvePath(ctx.cwd, path);
  if (ctx.workspace.kind !== "local") return null;
  try {
    const st = await fsStat(fullPath);
    if (!st.isFile()) return null;
    return st.mtimeMs;
  } catch {
    return null;
  }
}
