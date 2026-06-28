import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHookRegistry } from "./registry.js";
import {
  DELEGATE_READ_BYTE_THRESHOLD,
  DELEGATE_READ_LINE_THRESHOLD,
  installDelegateReadGate,
  isBroadRead,
  MAX_TARGETED_READ_LINES,
} from "./delegate-read-gate.js";
import type { AgentContext } from "../types.js";
import { createLocalWorkspace } from "../workspace/local.js";
import { writeTool } from "../tools/write.js";

describe("isBroadRead", () => {
  it("treats unbounded reads as broad", () => {
    expect(isBroadRead({ path: "a.ts" })).toBe(true);
    expect(isBroadRead({ path: "a.ts", limit: 2000 })).toBe(true);
  });

  it("allows targeted reads", () => {
    expect(isBroadRead({ path: "a.ts", limit: MAX_TARGETED_READ_LINES })).toBe(false);
    expect(isBroadRead({ path: "a.ts", offset: 100, limit: 50 })).toBe(false);
    expect(isBroadRead({ path: "a.ts", offset: 500 })).toBe(false);
  });
});

describe("installDelegateReadGate", () => {
  let cwd: string;
  let ctx: AgentContext;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "orin-delegate-read-gate-"));
    ctx = { cwd, messages: [], workspace: createLocalWorkspace() };
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function fireRead(args: { path: string; offset?: number; limit?: number }) {
    const hooks = createHookRegistry();
    installDelegateReadGate(hooks);
    return hooks.fireHook("before_tool", { id: "tc1", name: "read", args }, ctx);
  }

  it("allows small files", async () => {
    await writeTool.execute(
      { path: "small.txt", content: "hello\n" },
      ctx,
      new AbortController().signal,
    );

    const result = await fireRead({ path: "small.txt" });
    expect(result).toBeUndefined();
  });

  it("blocks broad reads of large files on the main agent", async () => {
    const body = Array.from(
      { length: DELEGATE_READ_LINE_THRESHOLD + 1 },
      (_, i) => `line ${i + 1}`,
    ).join("\n") + "\n";
    await writeTool.execute({ path: "big.txt", content: body }, ctx, new AbortController().signal);

    const result = await fireRead({ path: "big.txt" });
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("delegate_read"),
    });
    expect((result as { reason: string }).reason).toContain("big.txt");
  });

  it("allows targeted reads of large files", async () => {
    const body = Array.from(
      { length: DELEGATE_READ_LINE_THRESHOLD + 1 },
      (_, i) => `line ${i + 1}`,
    ).join("\n") + "\n";
    await writeTool.execute({ path: "big.txt", content: body }, ctx, new AbortController().signal);

    const result = await fireRead({ path: "big.txt", limit: 40 });
    expect(result).toBeUndefined();

    const paged = await fireRead({ path: "big.txt", offset: 100, limit: 40 });
    expect(paged).toBeUndefined();
  });

  it("blocks broad reads of byte-heavy files", async () => {
    const body = "x".repeat(DELEGATE_READ_BYTE_THRESHOLD + 1);
    await writeTool.execute({ path: "chunk.js", content: body }, ctx, new AbortController().signal);

    const result = await fireRead({ path: "chunk.js" });
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("delegate_read"),
    });
  });

  it("does not block subagent reads", async () => {
    const body = Array.from(
      { length: DELEGATE_READ_LINE_THRESHOLD + 1 },
      (_, i) => `line ${i + 1}`,
    ).join("\n") + "\n";
    await writeTool.execute({ path: "big.txt", content: body }, ctx, new AbortController().signal);

    ctx.depth = 1;
    const result = await fireRead({ path: "big.txt" });
    expect(result).toBeUndefined();
  });
});
