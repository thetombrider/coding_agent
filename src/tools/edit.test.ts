import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { applyExactEdits, applyFuzzyEdits, editTool } from "./edit.js";
import { writeTool } from "./write.js";
import { grepTool } from "./grep.js";
import type { AgentContext } from "../types.js";
import { createLocalWorkspace } from "../workspace/local.js";
import { EditMismatchError } from "../edit/replacers.js";

describe("applyExactEdits", () => {
  it("replaces unique text against original", () => {
    expect(applyExactEdits("hello world", [{ oldText: "world", newText: "there" }])).toBe(
      "hello there",
    );
  });

  it("rejects ambiguous matches without startLine", () => {
    expect(() =>
      applyExactEdits("foo foo", [{ oldText: "foo", newText: "bar" }]),
    ).toThrow(EditMismatchError);
  });

  it("disambiguates non-unique oldText with startLine", () => {
    expect(
      applyExactEdits("foo\nbar\nfoo\n", [
        { oldText: "foo", newText: "baz", startLine: 3 },
      ]),
    ).toBe("foo\nbar\nbaz\n");
  });

  it("applies out-of-order multi-block edits correctly", () => {
    const original = "aaa\nbbb\nccc\nddd\n";
    const result = applyFuzzyEdits(original, [
      { oldText: "ccc", newText: "CCC" },
      { oldText: "aaa", newText: "AAA" },
      { oldText: "bbb", newText: "BBB" },
    ]);
    expect(result).toBe("AAA\nBBB\nCCC\nddd\n");
  });

  it("applies multi-block edits with different-length replacements", () => {
    const original = "one\ntwo\nthree\n";
    const result = applyFuzzyEdits(original, [
      { oldText: "two", newText: "TWO-LINES\nSECOND" },
      { oldText: "one", newText: "ONE" },
    ]);
    expect(result).toBe("ONE\nTWO-LINES\nSECOND\nthree\n");
  });
});

describe("editTool mismatch diagnostics", () => {
  it("returns isError with diagnostic output on mismatch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orin-edit-"));
    const ctx: AgentContext = { cwd, messages: [], workspace: createLocalWorkspace() };

    try {
      await writeTool.execute(
        { path: "sample.ts", content: "const x = 1;\nconst y = 2;\n" },
        ctx,
        new AbortController().signal,
      );

      const result = await editTool.execute(
        {
          path: "sample.ts",
          edits: [{ oldText: "const z = 99;", newText: "const z = 0;" }],
        },
        ctx,
        new AbortController().signal,
      );

      expect(result.isError).toBe(true);
      expect(result.output).toMatch(/could not be applied/i);
      expect(result.output).toMatch(/similar/i);
      expect(result.output).toMatch(/line \d+/);
      expect(result.output).toMatch(/Matchers tried/);

      const content = await readFile(join(cwd, "sample.ts"), "utf8");
      expect(content).toBe("const x = 1;\nconst y = 2;\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("phase 3 tools integration", () => {
  it("write, edit, grep end-to-end", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orin-"));
    const ctx: AgentContext = { cwd, messages: [], workspace: createLocalWorkspace() };

    try {
      await writeTool.execute(
        { path: "hello.ts", content: "export const greet = () => 'hello';\n" },
        ctx,
        new AbortController().signal,
      );

      await editTool.execute(
        {
          path: "hello.ts",
          edits: [{ oldText: "'hello'", newText: "'hi'" }],
        },
        ctx,
        new AbortController().signal,
      );

      const content = await readFile(join(cwd, "hello.ts"), "utf8");
      expect(content).toContain("'hi'");

      const grep = await grepTool.execute(
        { pattern: "greet", path: "hello.ts" },
        ctx,
        new AbortController().signal,
      );
      expect(grep.output).toMatch(/greet/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
