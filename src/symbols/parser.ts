import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";

export type Dialect = "typescript" | "tsx" | "javascript";

let initPromise: Promise<void> | null = null;
const languages = new Map<Dialect, Language>();

function pkgDir(name: string): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve(`${name}/package.json`));
}

async function loadWasm(pkg: string, file: string): Promise<Language> {
  const path = join(pkgDir(pkg), file);
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
