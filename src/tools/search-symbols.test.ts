import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { searchSymbolsTool } from "./search-symbols.js";
import { createSymbolService } from "../symbols/service.js";
import { attachSymbolService } from "../symbols/hook.js";
import { createLocalWorkspace } from "../workspace/local.js";
import type { AgentContext } from "../types.js";

const sig = () => new AbortController().signal;

describe("searchSymbolsTool", () => {
  let cwd: string;
  let ctx: AgentContext;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "orin-search-sym-"));
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src/foo.ts"), "export function findMe() { return 1; }\n");
    ctx = { cwd, messages: [], workspace: createLocalWorkspace() };
    attachSymbolService(ctx, createSymbolService());
    await ctx.symbols!.warmIndex(ctx.workspace, cwd);
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("finds a definition", async () => {
    const result = await searchSymbolsTool.execute({ query: "findMe" }, ctx, sig());
    expect(result.output).toMatch(/src\/foo\.ts/);
    expect(result.output).toMatch(/findMe/);
  });

  it("reports unavailable without symbol service", async () => {
    const bare: AgentContext = { cwd, messages: [], workspace: createLocalWorkspace() };
    const result = await searchSymbolsTool.execute({ query: "findMe" }, bare, sig());
    expect(result.isError).toBe(true);
  });
});
