import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";

export type Dialect = "typescript" | "tsx" | "javascript";

let initPromise: Promise<void> | null = null;
const languages = new Map<Dialect, Language>();

/** Walk up from `start` to find the Orin package root (contains package.json). */
function findPackageRoot(start: string): string {
  let dir = start;
  while (true) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function pkgDir(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = findPackageRoot(here);
  const req = createRequire(join(root, "package.json"));
  try {
    return dirname(req.resolve(`${name}/package.json`));
  } catch {
    throw new Error(
      `Symbol index grammar "${name}" is not installed. `
      + "Re-run ./install.sh (or `bun install`) from the Orin package, then restart the session.",
    );
  }
}

async function loadWasm(pkg: string, file: string): Promise<Language> {
  const path = join(pkgDir(pkg), file);
  if (!existsSync(path)) {
    throw new Error(`Symbol index WASM not found at ${path}. Re-run ./install.sh and restart.`);
  }
  return Language.load(readFileSync(path));
}

export async function ensureParserReady(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
}

export async function getLanguage(dialect: Dialect): Promise<Language> {
  await ensureParserReady();
  const cached = languages.get(dialect);
  if (cached) return cached;

  let lang: Language;
  switch (dialect) {
    case "typescript":
      lang = await loadWasm("tree-sitter-typescript", "tree-sitter-typescript.wasm");
      break;
    case "tsx":
      lang = await loadWasm("tree-sitter-typescript", "tree-sitter-tsx.wasm");
      break;
    case "javascript":
      lang = await loadWasm("tree-sitter-javascript", "tree-sitter-javascript.wasm");
      break;
  }
  languages.set(dialect, lang);
  return lang;
}

export function dialectForPath(path: string): Dialect | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".ts")) return "typescript";
  if (/\.(jsx?|mjs|cjs)$/.test(lower)) return "javascript";
  return null;
}

export function isIndexablePath(path: string): boolean {
  return dialectForPath(path) !== null;
}

export async function createParser(dialect: Dialect): Promise<Parser> {
  await ensureParserReady();
  const parser = new Parser();
  parser.setLanguage(await getLanguage(dialect));
  return parser;
}
