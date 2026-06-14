import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { applyExactEdits, editTool } from "./edit.js";
import { writeTool } from "./write.js";
import { grepTool } from "./grep.js";
import type { AgentContext } from "../types.js";

describe("applyExactEdits", () => {
  it("replaces unique text against original", () => {
    expect(applyExactEdits("hello world", [{ oldText: "world", newText: "there" }])).toBe(
      "hello there",
    );
  });

  it("rejects ambiguous matches", () => {
    expect(() =>
      applyExactEdits("foo foo", [{ oldText: "foo", newText: "bar" }]),
    ).toThrow(/multiple times|edit failed/);
  });
});

describe("phase 3 tools integration", () => {
  it("write, edit, grep end-to-end", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "minicoder-"));
    const ctx: AgentContext = { cwd, messages: [] };

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
