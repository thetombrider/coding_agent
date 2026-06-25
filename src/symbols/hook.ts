import { isAbsolute, relative } from "node:path";
import type { HookRegistryImpl } from "../hooks/registry.js";
import type { AgentContext } from "../types.js";
import { isIndexablePath } from "./parser.js";
import type { SymbolService } from "./service.js";

function relPath(cwd: string, path: string): string {
  if (isAbsolute(path)) return relative(cwd, path).replace(/\\/g, "/");
  return path.replace(/\\/g, "/");
}

function pathFromArgs(name: string, args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const rec = args as Record<string, unknown>;
  if (name === "file_op") {
    return typeof rec.source === "string" ? rec.source : null;
  }
  return typeof rec.path === "string" ? rec.path : null;
}

export function installSymbolIndexHooks(hooks: HookRegistryImpl): void {
  hooks.on("session_start", ({ cwd }, ctx) => {
    if (!ctx.symbols) return;
    void ctx.symbols.warmIndex(ctx.workspace, cwd);
  });

  hooks.on("after_tool", async ({ name, args }, ctx) => {
    const symbols = ctx.symbols;
    if (!symbols) return;

    if (name === "file_op") {
      const rec = args as { operation?: string; source?: string; destination?: string };
      if (rec.operation === "delete" && rec.source) {
        symbols.removeFile(relPath(ctx.cwd, rec.source));
        return;
      }
      if (rec.operation === "move") {
        if (rec.source) symbols.removeFile(relPath(ctx.cwd, rec.source));
        if (rec.destination && isIndexablePath(rec.destination)) {
          await symbols.reindexFile(ctx.workspace, ctx.cwd, rec.destination);
        }
        return;
      }
    }

    if (name !== "write" && name !== "edit") return;
    const path = pathFromArgs(name, args);
    if (!path || !isIndexablePath(path)) return;
    await symbols.reindexFile(ctx.workspace, ctx.cwd, path);
  });
}

export function attachSymbolService(ctx: AgentContext, symbols: SymbolService): void {
  ctx.symbols = symbols;
}
