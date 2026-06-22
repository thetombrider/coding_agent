import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import type { AgentContext } from "../types.js";
import { createLocalWorkspace } from "../workspace/local.js";

describe("readTool", () => {
  let cwd: string;
  let ctx: AgentContext;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "orin-read-"));
    ctx = { cwd, messages: [], workspace: createLocalWorkspace() };
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("reads a file by relative path", async () => {
    await writeTool.execute(
      { path: "note.txt", content: "hello world\n" },
      ctx,
      new AbortController().signal,
    );

    const result = await readTool.execute(
      { path: "note.txt" },
      ctx,
      new AbortController().signal,
    );

    expect(result.output).toBe("hello world\n");
    expect(result.isError).toBeUndefined();
  });

  it("reads a file by absolute path", async () => {
    const abs = join(cwd, "abs.txt");
    await writeTool.execute(
      { path: abs, content: "absolute\n" },
      ctx,
      new AbortController().signal,
    );

    const result = await readTool.execute(
      { path: abs },
      ctx,
      new AbortController().signal,
    );

    expect(result.output).toBe("absolute\n");
  });

  it("reads nested file paths", async () => {
    await writeTool.execute(
      { path: "a/b/c.txt", content: "nested\n" },
      ctx,
      new AbortController().signal,
    );

    const result = await readTool.execute(
      { path: "a/b/c.txt" },
      ctx,
      new AbortController().signal,
    );

    expect(result.output).toBe("nested\n");
  });

  it("rejects when the file does not exist", async () => {
    await expect(
      readTool.execute({ path: "missing.txt" }, ctx, new AbortController().signal),
    ).rejects.toThrow();
  });

  it("pages through a file with offset and limit and points at the next offset", async () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    await writeTool.execute({ path: "big.txt", content: body }, ctx, new AbortController().signal);

    const first = await readTool.execute(
      { path: "big.txt", limit: 3 },
      ctx,
      new AbortController().signal,
    );
    expect(first.output).toContain("line 1");
    expect(first.output).toContain("line 3");
    expect(first.output).not.toContain("line 4");
    expect(first.output).toContain("offset 4");

    const next = await readTool.execute(
      { path: "big.txt", offset: 4, limit: 3 },
      ctx,
      new AbortController().signal,
    );
    expect(next.output).toContain("line 4");
    expect(next.output).toContain("line 6");
    expect(next.output).not.toContain("line 3");
  });

  it("caps an unbounded read at the default line limit", async () => {
    const body = Array.from({ length: 2100 }, (_, i) => `L${i + 1}`).join("\n") + "\n";
    await writeTool.execute({ path: "huge.txt", content: body }, ctx, new AbortController().signal);

    const result = await readTool.execute(
      { path: "huge.txt" },
      ctx,
      new AbortController().signal,
    );
    expect(result.output).toContain("L1");
    expect(result.output).toContain("L2000");
    expect(result.output).not.toContain("L2001\n");
    expect(result.output).toContain("100 more lines");
  });
});
