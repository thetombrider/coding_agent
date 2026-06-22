import { mkdtemp, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileOpTool } from "./file-op.js";
import type { AgentContext } from "../types.js";
import { createLocalWorkspace } from "../workspace/local.js";

describe("fileOpTool", () => {
  let cwd: string;
  let ctx: AgentContext;
  const signal = new AbortController().signal;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "orin-fileop-"));
    ctx = { cwd, messages: [], workspace: createLocalWorkspace() };
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("always requires approval", () => {
    expect(fileOpTool.needsApproval?.({ operation: "delete", source: "x" }, ctx)).toBe(true);
  });

  it("deletes a file", async () => {
    await writeFile(join(cwd, "gone.txt"), "bye");
    const r = await fileOpTool.execute({ operation: "delete", source: "gone.txt" }, ctx, signal);
    expect(r.isError).toBeUndefined();
    expect(r.output).toContain("Deleted");
    await expect(stat(join(cwd, "gone.txt"))).rejects.toThrow();
  });

  it("refuses to delete a directory", async () => {
    await mkdir(join(cwd, "adir"));
    const r = await fileOpTool.execute({ operation: "delete", source: "adir" }, ctx, signal);
    expect(r.isError).toBe(true);
    expect(r.output).toBe("file_op delete is files-only; use bash rm -r for directories");
    // Directory must be untouched.
    expect((await stat(join(cwd, "adir"))).isDirectory()).toBe(true);
  });

  it("moves a file into an existing directory", async () => {
    await writeFile(join(cwd, "from.txt"), "data");
    await mkdir(join(cwd, "sub"));
    const r = await fileOpTool.execute(
      { operation: "move", source: "from.txt", destination: "sub/to.txt" },
      ctx,
      signal,
    );
    expect(r.isError).toBeUndefined();
    expect((await stat(join(cwd, "sub/to.txt"))).isFile()).toBe(true);
    await expect(stat(join(cwd, "from.txt"))).rejects.toThrow();
  });

  it("errors when the move destination parent is missing", async () => {
    await writeFile(join(cwd, "from.txt"), "data");
    const r = await fileOpTool.execute(
      { operation: "move", source: "from.txt", destination: "nope/to.txt" },
      ctx,
      signal,
    );
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/destination directory does not exist/i);
    // Source must remain in place when the move is rejected.
    expect((await stat(join(cwd, "from.txt"))).isFile()).toBe(true);
  });

  it("errors when move is missing a destination", async () => {
    await writeFile(join(cwd, "from.txt"), "data");
    const r = await fileOpTool.execute({ operation: "move", source: "from.txt" }, ctx, signal);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/destination is required/i);
  });

  it("errors when the source does not exist", async () => {
    const r = await fileOpTool.execute({ operation: "delete", source: "ghost.txt" }, ctx, signal);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/not found/i);
  });

  it("rejects a source path that escapes the workspace", async () => {
    const r = await fileOpTool.execute({ operation: "delete", source: "../escape.txt" }, ctx, signal);
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/outside the workspace/i);
  });

  it("rejects a move destination that escapes the workspace", async () => {
    await writeFile(join(cwd, "from.txt"), "data");
    const r = await fileOpTool.execute(
      { operation: "move", source: "from.txt", destination: "../escape.txt" },
      ctx,
      signal,
    );
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/outside the workspace/i);
  });
});
