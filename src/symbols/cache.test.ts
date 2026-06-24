import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CACHE_VERSION,
  cachePath,
  contentHash,
  fileFingerprint,
  loadCache,
  repoHash,
  saveCache,
  symbolIndexDir,
} from "./cache.js";
import { createLocalWorkspace } from "../workspace/local.js";
import type { SymbolIndexCache } from "./cache.js";

describe("symbol index cache", () => {
  let home: string;
  let prevHome: string | undefined;
  let cwd: string;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "orin-cache-home-"));
    cwd = mkdtempSync(join(tmpdir(), "orin-cache-repo-"));
    process.env.HOME = home;
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src/a.ts"), "export function cached() {}\n");
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("writes cache under ~/.orin/index/<repo-hash>.json", () => {
    const cache: SymbolIndexCache = {
      version: CACHE_VERSION,
      repoRoot: cwd,
      files: {
        "src/a.ts": {
          mtimeMs: 1,
          contentHash: contentHash("export function cached() {}\n"),
          symbols: [],
          references: [],
        },
      },
    };
    saveCache(cwd, cache);
    expect(cachePath(cwd)).toBe(join(symbolIndexDir(), `${repoHash(cwd)}.json`));
    expect(readFileSync(cachePath(cwd), "utf8")).toContain("src/a.ts");
  });

  it("loads a valid cache", () => {
    const cache: SymbolIndexCache = {
      version: CACHE_VERSION,
      repoRoot: cwd,
      files: {},
    };
    saveCache(cwd, cache);
    expect(loadCache(cwd)).toEqual(cache);
  });

  it("returns null for missing or corrupt cache", () => {
    expect(loadCache(cwd)).toBeNull();
    mkdirSync(symbolIndexDir(), { recursive: true });
    writeFileSync(cachePath(cwd), "{not json");
    expect(loadCache(cwd)).toBeNull();
  });

  it("returns null when repo root does not match", () => {
    saveCache(cwd, { version: CACHE_VERSION, repoRoot: "/other/path", files: {} });
    expect(loadCache(cwd)).toBeNull();
  });

  it("detects unchanged files via mtime without re-reading content", async () => {
    const workspace = createLocalWorkspace();
    const full = join(cwd, "src/a.ts");
    const st = await import("node:fs/promises").then((m) => m.stat(full));
    const hash = contentHash("export function cached() {}\n");
    const fp = await fileFingerprint(workspace, cwd, "src/a.ts", {
      mtimeMs: st.mtimeMs,
      contentHash: hash,
      symbols: [],
      references: [],
    });
    expect(fp).toEqual({ mtimeMs: st.mtimeMs, contentHash: hash });
  });
});
