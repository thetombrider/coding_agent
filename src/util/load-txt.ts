import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Load a `.txt` file relative to `src/` (e.g. `tools/read.txt`). */
export function loadTxt(relativeToSrc: string): string {
  return readFileSync(join(srcRoot, relativeToSrc), "utf8").trim();
}

/** Load a tool description from `src/tools/<name>.txt`. */
export function loadToolDescription(toolName: string): string {
  return loadTxt(`tools/${toolName}.txt`);
}
