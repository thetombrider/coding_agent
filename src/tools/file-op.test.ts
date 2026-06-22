import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileOpTool } from "./file-op.js";
import type { AgentContext } from "../types.js";
import { createLocalWorkspace } from "../workspace/local.js";

describe("fileOpTool", () => {
  let cwd: string;
  let ctx: AgentContext;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "orin-file-op-"));
    ctx = { cwd, messages: [], workspace: createLocalWorkspace() };
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("always requires approval", () => {
    expect(fileOpTool.needsApproval?.({ operation: "delete", source: "x" }, ctx)).toBe(true);
  });

  it("deletes a file", async () => {
    const filePath = join(cwd, "remove-me.txt");
    await writeFile(filePath, "bye");

    const result = await fileOpTool.execute(
      { operation: "delete", source: "remove-me.txt" },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("Deleted remove-me.txt");
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
  });

  it("refuses directory delete", async () => {
    await mkdir(join(cwd, "dir-only"));

    const result = await fileOpTool.execute(
      { operation: "delete", source: "dir-only" },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("files-only");
  });

  it("moves a file", async () => {
    await writeFile(join(cwd, "old.txt"), "payload");

    const result = await fileOpTool.execute(
      { operation: "move", source: "old.txt", destination: "new.txt" },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("Moved old.txt → new.txt");
    expect(await readFile(join(cwd, "new.txt"), "utf8")).toBe("payload");
  });

  it("errors when destination parent is missing", async () => {
    await writeFile(join(cwd, "src.txt"), "payload");

    const result = await fileOpTool.execute(
      { operation: "move", source: "src.txt", destination: "missing/dir/dest.txt" },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Destination parent directory does not exist");
  });

  it("errors when source does not exist", async () => {
    const result = await fileOpTool.execute(
      { operation: "delete", source: "nope.txt" },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("does not exist");
  });

  it("rejects path escape outside workspace root", async () => {
    const result = await fileOpTool.execute(
      { operation: "delete", source: "../outside.txt" },
      ctx,
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("escapes workspace root");
  });
});
