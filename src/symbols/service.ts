import { isAbsolute, relative } from "node:path";
import { findMatchingFiles } from "../tools/find.js";
import type { Workspace } from "../workspace/types.js";
import { extractFromSource } from "./extract.js";
import { queryIndex } from "./graph.js";
import { SymbolIndex } from "./index.js";
import { ensureParserReady, isIndexablePath } from "./parser.js";
import type { IndexStats, SearchMode, SearchOpts } from "./types.js";

const INDEX_GLOBS = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"];
const WARM_CONCURRENCY = 8;

async function listIndexableFiles(workspace: Workspace, cwd: string): Promise<string[]> {
  const files = new Set<string>();
  for (const pattern of INDEX_GLOBS) {
    for (const file of await findMatchingFiles(workspace, cwd, pattern)) {
      if (isIndexablePath(file)) files.add(file);
    }
  }
  return [...files].sort();
}

export interface SymbolService {
  readonly ready: boolean;
  warmIndex(workspace: Workspace, cwd: string): Promise<IndexStats>;
  reindexFile(workspace: Workspace, cwd: string, relPath: string): Promise<void>;
  removeFile(relPath: string): void;
  query(query: string, mode: SearchMode, opts?: SearchOpts): ReturnType<typeof queryIndex>;
  allSymbols(): import("./types.js").Symbol[];
}

export function createSymbolService(): SymbolService {
  const index = new SymbolIndex();
  let warming: Promise<IndexStats> | null = null;
  let ready = false;

  async function indexFile(workspace: Workspace, cwd: string, relPath: string): Promise<void> {
    if (!isIndexablePath(relPath)) return;
    const full = relPath.startsWith("/") ? relPath : `${cwd}/${relPath}`.replace(/\/+/g, "/");
    let source: string;
    try {
      source = await workspace.readFile(full);
    } catch {
      index.removeFile(relPath);
      return;
    }
    const extracted = await extractFromSource(relPath, source);
    if (!extracted) return;
    index.replaceFile(relPath, extracted.symbols, extracted.references);
  }

  async function warmIndex(workspace: Workspace, cwd: string): Promise<IndexStats> {
    if (warming) return warming;
    warming = (async () => {
      const start = performance.now();
      await ensureParserReady();
      const files = await listIndexableFiles(workspace, cwd);
      const indexable = files;

      let i = 0;
      async function worker(): Promise<void> {
        while (i < indexable.length) {
          const file = indexable[i++]!;
          await indexFile(workspace, cwd, file);
        }
      }
      await Promise.all(Array.from({ length: WARM_CONCURRENCY }, () => worker()));

      ready = true;
      const stats: IndexStats = {
        files: index.fileCount,
        symbols: index.symbolCount,
        references: index.referenceCount,
        elapsedMs: Math.round(performance.now() - start),
      };
      process.stderr.write(
        `[symbols] Indexed ${stats.files} files, ${stats.symbols} symbols (${stats.elapsedMs}ms)\n`,
      );
      return stats;
    })();
    return warming;
  }

  return {
    get ready() {
      return ready;
    },
    warmIndex,
    async reindexFile(workspace, cwd, relPath) {
      await ensureParserReady();
      const normalized = isAbsolute(relPath)
        ? relative(cwd, relPath).replace(/\\/g, "/")
        : relPath.replace(/\\/g, "/");
      await indexFile(workspace, cwd, normalized);
    },
    removeFile(relPath) {
      index.removeFile(relPath.replace(/\\/g, "/"));
    },
    query(query, mode, opts) {
      return queryIndex(index, query, mode, opts);
    },
    allSymbols() {
      return index.allSymbols();
    },
  };
}
