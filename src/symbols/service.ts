import { isAbsolute, relative, resolve } from "node:path";
import { findMatchingFiles } from "../tools/find.js";
import type { Workspace } from "../workspace/types.js";
import {
  type CachedFileEntry,
  type SymbolIndexCache,
  fileFingerprint,
  loadCache,
  saveCache,
} from "./cache.js";
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

export interface SymbolServiceOptions {
  /** Log warm stats to stderr when indexing completes. Headless only — TUI owns the terminal. */
  logWarmStats?: boolean;
}

export interface SymbolService {
  readonly ready: boolean;
  warmIndex(workspace: Workspace, cwd: string): Promise<IndexStats>;
  reindexFile(workspace: Workspace, cwd: string, relPath: string): Promise<void>;
  removeFile(relPath: string): void;
  query(query: string, mode: SearchMode, opts?: SearchOpts): ReturnType<typeof queryIndex>;
  allSymbols(): import("./types.js").Symbol[];
}

export function createSymbolService(options: SymbolServiceOptions = {}): SymbolService {
  const { logWarmStats = false } = options;
  const index = new SymbolIndex();
  let warming: Promise<IndexStats> | null = null;
  let ready = false;
  let cacheState: SymbolIndexCache | null = null;
  let cacheCwd: string | null = null;

  function ensureCacheState(cwd: string): SymbolIndexCache {
    cacheCwd = resolve(cwd);
    cacheState ??= loadCache(cwd) ?? { version: 1, repoRoot: cacheCwd, files: {} };
    if (resolve(cacheState.repoRoot) !== cacheCwd) {
      cacheState = { version: 1, repoRoot: cacheCwd, files: {} };
    }
    return cacheState;
  }

  async function persistCache(cwd: string, workspace: Workspace, files: string[]): Promise<void> {
    const cache = ensureCacheState(cwd);
    const nextFiles: Record<string, CachedFileEntry> = {};
    for (const relPath of files) {
      const data = index.getFileData(relPath);
      if (!data) continue;
      const fp = await fileFingerprint(workspace, cwd, relPath);
      if (!fp) continue;
      nextFiles[relPath] = { ...fp, symbols: data.symbols, references: data.references };
    }
    cache.files = nextFiles;
    saveCache(cwd, cache);
  }

  async function indexFile(workspace: Workspace, cwd: string, relPath: string): Promise<void> {
    if (!isIndexablePath(relPath)) return;
    const full = relPath.startsWith("/") ? relPath : `${cwd}/${relPath}`.replace(/\/+/g, "/");
    let source: string;
    try {
      source = await workspace.readFile(full);
    } catch {
      index.removeFile(relPath);
      if (cacheState) delete cacheState.files[relPath];
      return;
    }
    const extracted = await extractFromSource(relPath, source);
    if (!extracted) return;
    index.replaceFile(relPath, extracted.symbols, extracted.references);
    const fp = await fileFingerprint(workspace, cwd, relPath);
    if (fp && cacheState) {
      cacheState.files[relPath] = {
        ...fp,
        symbols: extracted.symbols,
        references: extracted.references,
      };
    }
  }

  async function warmIndex(workspace: Workspace, cwd: string): Promise<IndexStats> {
    if (warming) return warming;
    warming = (async () => {
      const start = performance.now();
      await ensureParserReady();
      const files = await listIndexableFiles(workspace, cwd);
      const cache = loadCache(cwd);
      const stale: string[] = [];
      const freshEntries: Array<{ file: string; symbols: CachedFileEntry["symbols"]; references: CachedFileEntry["references"] }> = [];

      if (cache) {
        cacheState = cache;
        cacheCwd = resolve(cwd);
        for (const relPath of files) {
          const entry = cache.files[relPath];
          if (!entry) {
            stale.push(relPath);
            continue;
          }
          const fp = await fileFingerprint(workspace, cwd, relPath, entry);
          if (!fp || fp.mtimeMs !== entry.mtimeMs || fp.contentHash !== entry.contentHash) {
            stale.push(relPath);
            continue;
          }
          freshEntries.push({ file: relPath, symbols: entry.symbols, references: entry.references });
        }
        index.loadFiles(freshEntries);
        if (freshEntries.length > 0) ready = true;
      } else {
        cacheState = ensureCacheState(cwd);
        stale.push(...files);
      }

      let i = 0;
      async function worker(): Promise<void> {
        while (i < stale.length) {
          const file = stale[i++]!;
          await indexFile(workspace, cwd, file);
        }
      }
      await Promise.all(Array.from({ length: WARM_CONCURRENCY }, () => worker()));

      ready = true;
      await persistCache(cwd, workspace, files);

      const stats: IndexStats = {
        files: index.fileCount,
        symbols: index.symbolCount,
        references: index.referenceCount,
        elapsedMs: Math.round(performance.now() - start),
      };
      if (logWarmStats) {
        const fromCache = freshEntries.length;
        const suffix = fromCache > 0 ? `, ${fromCache} from cache` : "";
        process.stderr.write(
          `[symbols] Indexed ${stats.files} files, ${stats.symbols} symbols (${stats.elapsedMs}ms${suffix})\n`,
        );
      }
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
      ensureCacheState(cwd);
      await indexFile(workspace, cwd, normalized);
      if (cacheState && cacheCwd === resolve(cwd)) {
        saveCache(cwd, cacheState);
      }
    },
    removeFile(relPath) {
      const normalized = relPath.replace(/\\/g, "/");
      index.removeFile(normalized);
      if (cacheState && cacheCwd) {
        delete cacheState.files[normalized];
        saveCache(cacheCwd, cacheState);
      }
    },
    query(query, mode, opts) {
      return queryIndex(index, query, mode, opts);
    },
    allSymbols() {
      return index.allSymbols();
    },
  };
}
