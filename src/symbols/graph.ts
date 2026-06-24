import type { Reference, SearchMode, SearchOpts, Symbol } from "./types.js";
import type { SymbolIndex } from "./index.js";

function filterSymbols(symbols: Symbol[], opts?: SearchOpts): Symbol[] {
  let out = symbols;
  if (opts?.kind) out = out.filter((s) => s.kind === opts.kind);
  if (opts?.file) {
    const scope = opts.file.replace(/\\/g, "/");
    out = out.filter((s) => s.file === scope || s.file.startsWith(`${scope}/`));
  }
  const limit = opts?.limit ?? 50;
  return out.slice(0, limit);
}

function filterReferences(refs: Reference[], opts?: SearchOpts): Reference[] {
  let out = refs;
  if (opts?.file) {
    const scope = opts.file.replace(/\\/g, "/");
    out = out.filter((r) => r.file === scope || r.file.startsWith(`${scope}/`));
  }
  const limit = opts?.limit ?? 50;
  return out.slice(0, limit);
}

export function queryIndex(
  index: SymbolIndex,
  query: string,
  mode: SearchMode,
  opts?: SearchOpts,
): { symbols: Symbol[]; references: Reference[] } {
  switch (mode) {
    case "definitions":
      return { symbols: filterSymbols(index.getDefinitions(query), opts), references: [] };
    case "search":
      return { symbols: filterSymbols(index.searchByPrefix(query, opts?.limit ?? 50), opts), references: [] };
    case "references":
      return { symbols: [], references: filterReferences(index.getReferences(query), opts) };
    case "callers":
      return { symbols: filterSymbols(index.getCallers(query), opts), references: [] };
  }
}
