import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grepTool } from "./grep.js";
import { findTool } from "./find.js";
import { lsTool } from "./ls.js";
import { writeTool } from "./write.js";
import type { AgentContext } from "../types.js";
import { createLocalWorkspace } from "../workspace/local.js";

const sig = () => new AbortController().signal;

describe("search tools", () => {
  let cwd: string;
  let ctx: AgentContext;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "orin-search-"));
    ctx = { cwd, messages: [], workspace: createLocalWorkspace() };
    await writeTool.execute({ path: "a.ts", content: "export const alpha = 1;\n" }, ctx, sig());
    await writeTool.execute({ path: "b.ts", content: "export const beta = 2;\n" }, ctx, sig());
    await writeTool.execute({ path: "sub/c.ts", content: "export const gamma = 3;\n" }, ctx, sig());
    await writeTool.execute({ path: "sub/notes.md", content: "alpha mention\n" }, ctx, sig());
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  describe("grepTool", () => {
    it("finds matches across files", async () => {
      const result = await grepTool.execute({ pattern: "alpha" }, ctx, sig());
      expect(result.output).toMatch(/a\.ts/);
      expect(result.output).toMatch(/alpha = 1/);
    });

    it("filters by glob", async () => {
      const result = await grepTool.execute(
        { pattern: "alpha", glob: "*.md" },
        ctx,
        sig(),
      );
      expect(result.output).toMatch(/notes\.md/);
      expect(result.output).not.toMatch(/a\.ts/);
    });

    it("scopes the search to a path", async () => {
      const result = await grepTool.execute(
        { pattern: "export const", path: "sub" },
        ctx,
        sig(),
      );
      expect(result.output).toMatch(/gamma/);
      expect(result.output).not.toMatch(/alpha/);
    });

    it("reports no matches gracefully", async () => {
      const result = await grepTool.execute({ pattern: "zzznotpresent" }, ctx, sig());
      expect(result.output).toBe("(no matches)");
    });

    it("truncates oversized match output instead of throwing", async () => {
      // >256 KiB of matches: the byte cap should return partial output with a
      // note rather than killing the tool with a command-failed error.
      const big = Array.from({ length: 20_000 }, (_, i) => `match line ${i}`).join("\n") + "\n";
      await writeTool.execute({ path: "big.txt", content: big }, ctx, sig());
      const result = await grepTool.execute({ pattern: "match", path: "big.txt" }, ctx, sig());
      expect(result.output).toContain("[output truncated");
      expect(result.isError).toBeFalsy();
    });
  });

  describe("findTool", () => {
    it("matches top-level files with a single-star glob", async () => {
      const result = await findTool.execute({ pattern: "*.ts" }, ctx, sig());
      const lines = result.output.split("\n");
      expect(lines).toContain("a.ts");
      expect(lines).toContain("b.ts");
      // A single * does not cross directory boundaries.
      expect(lines).not.toContain("sub/c.ts");
    });

    it("matches nested files with a ** glob", async () => {
      const result = await findTool.execute({ pattern: "**/*.ts" }, ctx, sig());
      const lines = result.output.split("\n");
      expect(lines).toContain("sub/c.ts");
      expect(lines).not.toContain("sub/notes.md");
    });

    it("returns sorted results", async () => {
      await writeTool.execute({ path: "sub/a-first.ts", content: "//\n" }, ctx, sig());
      const result = await findTool.execute({ pattern: "**/*.ts" }, ctx, sig());
      const lines = result.output.split("\n");
      expect([...lines].sort()).toEqual(lines);
    });

    it("scopes to a subdirectory", async () => {
      const result = await findTool.execute({ pattern: "*.ts", path: "sub" }, ctx, sig());
      expect(result.output).toBe("c.ts");
    });

    it("reports no matches gracefully", async () => {
      const result = await findTool.execute({ pattern: "**/*.go" }, ctx, sig());
      expect(result.output).toBe("(no matches)");
    });
  });

  describe("lsTool", () => {
    it("lists files and directories with type prefixes", async () => {
      const result = await lsTool.execute({}, ctx, sig());
      const lines = result.output.split("\n");
      expect(lines).toContain("f a.ts");
      expect(lines).toContain("f b.ts");
      expect(lines).toContain("d sub");
    });

    it("lists a subdirectory", async () => {
      const result = await lsTool.execute({ path: "sub" }, ctx, sig());
      const lines = result.output.split("\n");
      expect(lines).toContain("f c.ts");
      expect(lines).toContain("f notes.md");
    });
  });
});
