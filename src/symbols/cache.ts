import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { stat as fsStat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Workspace } from "../workspace/types.js";
import type { Reference, Symbol } from "./types.js";

export const CACHE_VERSION = 1;

export interface FileFingerprint {
  mtimeMs: number;
  contentHash: string;
}

export interface CachedFileEntry extends FileFingerprint {
  symbols: Symbol[];
  references: Reference[];
}

export interface SymbolIndexCache {
  version: number;
  repoRoot: string;
  files: Record<string, CachedFileEntry>;
}

export function symbolIndexDir(): string {
  return join(homedir(), ".orin", "index");
}

export function repoHash(cwd: string): string {
  return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
}

export function cachePath(cwd: string): string {
  return join(symbolIndexDir(), `${repoHash(cwd)}.json`);
}

export function contentHash(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

function fullPath(cwd: string, relPath: string): string {
  return relPath.startsWith("/") ? relPath : join(cwd, relPath);
}

export async function fileFingerprint(
  workspace: Workspace,
  cwd: string,
  relPath: string,
  cached?: CachedFileEntry,
): Promise<FileFingerprint | null> {
  const full = fullPath(cwd, relPath);
  try {
    if (workspace.kind === "local") {
      const st = await fsStat(full);
      if (cached && cached.mtimeMs === st.mtimeMs) {
        return { mtimeMs: st.mtimeMs, contentHash: cached.contentHash };
      }
      const source = await workspace.readFile(full);
      return { mtimeMs: st.mtimeMs, contentHash: contentHash(source) };
    }
    const source = await workspace.readFile(full);
    return { mtimeMs: 0, contentHash: contentHash(source) };
  } catch {
    return null;
  }
}

export function loadCache(cwd: string): SymbolIndexCache | null {
  const path = cachePath(cwd);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SymbolIndexCache;
    if (parsed.version !== CACHE_VERSION) return null;
    if (typeof parsed.repoRoot !== "string" || typeof parsed.files !== "object" || parsed.files === null) {
      return null;
    }
    if (resolve(parsed.repoRoot) !== resolve(cwd)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCache(cwd: string, cache: SymbolIndexCache): void {
  const dir = symbolIndexDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = cachePath(cwd);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache), "utf8");
  renameSync(tmp, path);
}
