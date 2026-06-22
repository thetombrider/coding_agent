import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeTool } from "./write.js";
import type { AgentContext } from "../types.js";
import { createLocalWorkspace } from "../workspace/local.js";

describe("writeTool", () => {
  let cwd: string;
  let ctx: AgentContext;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "orin-write-"));
    ctx = { cwd, messages: [], workspace: createLocalWorkspace() };
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("always requires approval", () => {
    expect(writeTool.needsApproval?.({ path: "x", content: "y" }, ctx)).toBe(true);
  });

  it("writes a new file and reports byte count", async () => {
    const content = "const x = 1;\n";
    const result = await writeTool.execute(
      { path: "out.ts", content },
      ctx,
      new AbortController().signal,
    );

    expect(result.output).toBe(`Wrote out.ts (${content.length} bytes)`);
    expect(await readFile(join(cwd, "out.ts"), "utf8")).toBe(content);
  });

  it("creates parent directories as needed", async () => {
    await writeTool.execute(
      { path: "deep/nested/dir/file.txt", content: "hi" },
      ctx,
      new AbortController().signal,
    );

    expect(await readFile(join(cwd, "deep/nested/dir/file.txt"), "utf8")).toBe("hi");
  });

  it("overwrites an existing file", async () => {
    await writeTool.execute(
      { path: "f.txt", content: "first" },
      ctx,
      new AbortController().signal,
    );
    await writeTool.execute(
      { path: "f.txt", content: "second" },
      ctx,
      new AbortController().signal,
    );

    expect(await readFile(join(cwd, "f.txt"), "utf8")).toBe("second");
  });

  it("writes empty content", async () => {
    const result = await writeTool.execute(
      { path: "empty.txt", content: "" },
      ctx,
      new AbortController().signal,
    );

    expect(result.output).toBe("Wrote empty.txt (0 bytes)");
    expect(await readFile(join(cwd, "empty.txt"), "utf8")).toBe("");
  });
});
