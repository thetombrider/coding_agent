import type { Node } from "web-tree-sitter";
import {
  captureKind,
  createQueries,
  definitionKind,
  referenceType,
  type SymbolQueries,
} from "./queries.js";
import { createParser, dialectForPath, getLanguage, type Dialect } from "./parser.js";
import type { ExtractResult, Reference, Symbol, SymbolKind } from "./types.js";

const DEFINITION_KIND_MAP: Record<string, SymbolKind> = {
  function: "function",
  method: "method",
  class: "class",
  interface: "interface",
  module: "module",
  constant: "constant",
};

const ENCLOSING_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "generator_function",
  "generator_function_declaration",
  "method_definition",
  "method_signature",
  "arrow_function",
  "class_declaration",
  "class",
  "abstract_class_declaration",
  "function_definition",
  "class_definition",
  "decorated_definition",
]);

function line1(node: Node): number {
  return node.startPosition.row + 1;
}

function lineEnd(node: Node): number {
  return node.endPosition.row + 1;
}

function isExported(node: Node): boolean {
  let cur: Node | null = node;
  while (cur) {
    if (cur.type === "export_statement") return true;
    if (cur.type === "program" || cur.type === "statement_block") break;
    cur = cur.parent;
  }
  return false;
}

function symbolId(file: string, kind: SymbolKind, name: string, startLine: number): string {
  return `${file}:${startLine}:${kind}:${name}`;
}

function mapDefinitionKind(raw: string): SymbolKind {
  return DEFINITION_KIND_MAP[raw] ?? "variable";
}

function nameFromEnclosing(node: Node): string | null {
  for (const child of node.children) {
    if (child.type === "identifier" || child.type === "type_identifier" || child.type === "property_identifier") {
      return child.text;
    }
  }
  return null;
}

function findEnclosingId(node: Node, file: string, symbols: Symbol[]): string | undefined {
  let cur: Node | null = node.parent;
  while (cur) {
    if (ENCLOSING_TYPES.has(cur.type)) {
      const start = line1(cur);
      const end = lineEnd(cur);
      const hit = symbols.find((s) => s.file === file && s.startLine <= start && s.endLine >= end);
      if (hit) return hit.id;
      const name = nameFromEnclosing(cur);
      if (name) {
        const kind = cur.type.includes("method")
        ? "method"
        : cur.type.includes("class")
          ? "class"
          : cur.type === "function_definition" || cur.type === "decorated_definition"
            ? "function"
            : "function";
        return symbolId(file, kind, name, start);
      }
    }
    cur = cur.parent;
  }
  return undefined;
}

function collectDefinitions(
  file: string,
  matches: ReturnType<SymbolQueries["definitions"]["matches"]>,
): Symbol[] {
  const symbols: Symbol[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    let name: string | null = null;
    let defNode: Node | null = null;
    let rawKind = "function";

    for (const cap of match.captures) {
      const kind = captureKind(cap.name);
      if (kind === "name") name = cap.node.text;
      if (kind === "definition") {
        defNode = cap.node;
        rawKind = definitionKind(cap.name);
      }
    }
    if (!name || !defNode) continue;

    const mapped = mapDefinitionKind(rawKind);
    const startLine = line1(defNode);
    const id = symbolId(file, mapped, name, startLine);
    if (seen.has(id)) continue;
    seen.add(id);

    symbols.push({
      id,
      name,
      kind: mapped,
      file,
      startLine,
      endLine: lineEnd(defNode),
      exported: isExported(defNode),
    });
  }

  return symbols;
}

function collectReferences(
  file: string,
  symbols: Symbol[],
  refMatches: ReturnType<SymbolQueries["references"]["matches"]>,
): Reference[] {
  const refs: Reference[] = [];

  for (const match of refMatches) {
    let name: string | null = null;
    let refNode: Node | null = null;
    let type: Reference["type"] = "reference";

    for (const cap of match.captures) {
      const kind = captureKind(cap.name);
      if (kind === "name") name = cap.node.text;
      if (kind === "reference") {
        refNode = cap.node;
        type = referenceType(cap.name);
      }
    }
    if (!name || !refNode) continue;
    if (name === "require") continue;

    refs.push({
      fromId: findEnclosingId(refNode, file, symbols),
      to: name,
      file,
      line: line1(refNode),
      type,
    });
  }

  return refs;
}

export async function extractFromSource(file: string, source: string): Promise<ExtractResult | null> {
  const dialect: Dialect | null = dialectForPath(file);
  if (!dialect) return null;

  const parser = await createParser(dialect);
  const tree = parser.parse(source);
  if (!tree) return { symbols: [], references: [] };

  const language = await getLanguage(dialect);
  const queries = createQueries(language, dialect);
  const root = tree.rootNode;
  const defMatches = queries.definitions.matches(root);
  const refMatches = queries.references.matches(root);
  const symbols = collectDefinitions(file, defMatches);
  const references = collectReferences(file, symbols, refMatches);

  return { symbols, references };
}
