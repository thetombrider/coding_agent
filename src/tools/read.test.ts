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
});
