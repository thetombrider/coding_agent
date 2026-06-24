import { describe, expect, it } from "vitest";
import { SymbolIndex } from "./index.js";
import type { Reference, Symbol } from "./types.js";

const fn = (file: string, name: string, start: number): Symbol => ({
  id: `${file}:${start}:function:${name}`,
  name,
  kind: "function",
  file,
  startLine: start,
  endLine: start + 5,
});

describe("SymbolIndex", () => {
  it("indexes and retrieves definitions", () => {
    const index = new SymbolIndex();
    const sym = fn("src/a.ts", "foo", 1);
    index.replaceFile("src/a.ts", [sym], []);
    expect(index.getDefinitions("foo")).toEqual([sym]);
  });

  it("replaces file entries on update", () => {
    const index = new SymbolIndex();
    index.replaceFile("src/a.ts", [fn("src/a.ts", "foo", 1)], []);
    index.replaceFile("src/a.ts", [fn("src/a.ts", "bar", 10)], []);
    expect(index.getDefinitions("foo")).toEqual([]);
    expect(index.getDefinitions("bar")).toHaveLength(1);
  });

  it("tracks callers via call references", () => {
    const index = new SymbolIndex();
    const helper = fn("src/a.ts", "helper", 1);
    const main = fn("src/a.ts", "main", 10);
    const refs: Reference[] = [{ fromId: main.id, to: "helper", file: "src/a.ts", line: 12, type: "call" }];
    index.replaceFile("src/a.ts", [helper, main], refs);
    expect(index.getCallers("helper").map((s) => s.name)).toEqual(["main"]);
  });

  it("removes a file from the index", () => {
    const index = new SymbolIndex();
    index.replaceFile("src/a.ts", [fn("src/a.ts", "foo", 1)], []);
    index.removeFile("src/a.ts");
    expect(index.getDefinitions("foo")).toEqual([]);
    expect(index.fileCount).toBe(0);
  });

  it("bulk-loads files and rebuilds the call graph once", () => {
    const index = new SymbolIndex();
    const helper = fn("src/a.ts", "helper", 1);
    const main = fn("src/b.ts", "main", 10);
    const refs: Reference[] = [{ fromId: main.id, to: "helper", file: "src/b.ts", line: 12, type: "call" }];
    index.loadFiles([
      { file: "src/a.ts", symbols: [helper], references: [] },
      { file: "src/b.ts", symbols: [main], references: refs },
    ]);
    expect(index.getCallers("helper").map((s) => s.name)).toEqual(["main"]);
    expect(index.fileCount).toBe(2);
  });
});
