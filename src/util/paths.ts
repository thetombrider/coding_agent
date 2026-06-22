import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Resolve symlinks/`..` so containment checks compare real paths. */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Resolve `path` under `root` and reject escapes outside the workspace root. */
export function resolvePathWithinRoot(root: string, path: string): string {
  const rootReal = realPath(root);
  const full = resolvePath(root, path);
  const fullReal = realPath(full);
  const rel = relative(rootReal, fullReal);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace root: ${path}`);
  }
  return fullReal;
}
