import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { createHookRegistry } from "../hooks/registry.js";
import { installSymbolIndexHooks } from "./hook.js";
import { createSymbolService } from "./service.js";
import { attachSymbolService } from "./hook.js";
import { createLocalWorkspace } from "../workspace/local.js";
import type { AgentContext } from "../types.js";

describe("symbol index hooks", () => {
  let cwd: string;
  let ctx: AgentContext;
  const hooks = createHookRegistry();

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "orin-symbol-hook-"));
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src/a.ts"), "export function oldName() {}\n");
    ctx = { cwd, messages: [], workspace: createLocalWorkspace() };
    attachSymbolService(ctx, createSymbolService());
    installSymbolIndexHooks(hooks);
    await hooks.fireHook("session_start", { cwd }, ctx);
    await ctx.symbols!.warmIndex(ctx.workspace, cwd);
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("reindexes after write", async () => {
    await ctx.workspace.writeFile(join(cwd, "src/a.ts"), "export function newName() {}\n");
    await hooks.fireHook("after_tool", { name: "write", args: { path: "src/a.ts" }, output: "ok" }, ctx);
    const { symbols } = ctx.symbols!.query("newName", "definitions");
    expect(symbols.some((s) => s.name === "newName")).toBe(true);
  });
});
