import type { Reference, Symbol, SymbolKind } from "./types.js";

export function formatSymbol(sym: Symbol): string {
  const exportTag = sym.exported ? " export" : "";
  return `${sym.file}:${sym.startLine}:${sym.endLine} ${sym.kind} ${sym.name}${exportTag}`;
}

export function formatReference(ref: Reference, symbolsById: Map<string, Symbol>): string {
  const from = ref.fromId ? symbolsById.get(ref.fromId)?.name ?? ref.fromId : "(top-level)";
  return `${ref.file}:${ref.line} ${ref.type} ${ref.to}  ← from ${from}`;
}

export function formatResults(
  symbols: Symbol[],
  references: Reference[],
  allSymbols: Symbol[],
): string {
  if (!symbols.length && !references.length) return "(no matches)";

  const byId = new Map(allSymbols.map((s) => [s.id, s]));
  const lines: string[] = [];
  for (const sym of symbols) lines.push(formatSymbol(sym));
  for (const ref of references) lines.push(formatReference(ref, byId));
  return lines.join("\n");
}

export const SYMBOL_KINDS: SymbolKind[] = [
  "function",
  "method",
  "class",
  "interface",
  "variable",
  "constant",
  "module",
  "import",
  "export",
];
