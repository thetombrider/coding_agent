export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "variable"
  | "constant"
  | "module"
  | "import"
  | "export";

export type ReferenceType = "call" | "import" | "reference" | "class";

export interface Symbol {
  id: string;
  name: string;
  kind: SymbolKind;
  file: string;
  startLine: number;
  endLine: number;
  exported?: boolean;
}

export interface Reference {
  fromId?: string;
  to: string;
  file: string;
  line: number;
  type: ReferenceType;
}

export interface ExtractResult {
  symbols: Symbol[];
  references: Reference[];
}

export interface IndexStats {
  files: number;
  symbols: number;
  references: number;
  elapsedMs: number;
}

export type SearchMode = "definitions" | "references" | "callers" | "search";

export interface SearchOpts {
  kind?: SymbolKind;
  file?: string;
  limit?: number;
}
