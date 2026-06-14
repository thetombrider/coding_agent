import { isAbsolute, resolve } from "node:path";

export function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}
