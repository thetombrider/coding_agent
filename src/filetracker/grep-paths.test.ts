import { describe, expect, it } from "vitest";
import { pathsFromGrepOutput } from "./grep-paths.js";

describe("pathsFromGrepOutput", () => {
  const cwd = "/workspace";

  it("extracts paths from match lines", () => {
    const output = "src/foo.ts:10:const x = 1;\nsrc/bar.ts:3:export {}";
    expect(pathsFromGrepOutput(cwd, output)).toEqual([
      "/workspace/src/foo.ts",
      "/workspace/src/bar.ts",
    ]);
  });

  it("extracts paths from context lines", () => {
    const output = "src/foo.ts-9-context line\nsrc/foo.ts:10:match";
    expect(pathsFromGrepOutput(cwd, output)).toEqual(["/workspace/src/foo.ts"]);
  });

  it("deduplicates paths", () => {
    const output = "src/foo.ts:1:a\nsrc/foo.ts:2:b";
    expect(pathsFromGrepOutput(cwd, output)).toEqual(["/workspace/src/foo.ts"]);
  });

  it("returns empty for no matches", () => {
    expect(pathsFromGrepOutput(cwd, "(no matches)")).toEqual([]);
  });
});
