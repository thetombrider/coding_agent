import { Query, type Language } from "web-tree-sitter";
import type { Dialect } from "./parser.js";

const TS_DEFINITIONS = `
(function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (type_identifier) @name) @definition.class
(method_definition name: (property_identifier) @name) @definition.method
(lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function))) @definition.function
(interface_declaration name: (type_identifier) @name) @definition.interface
`;

const JS_DEFINITIONS = `
(function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (identifier) @name) @definition.class
(class name: (identifier) @name) @definition.class
(method_definition name: (property_identifier) @name) @definition.method
(lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)])) @definition.function
`;

const TS_REFERENCES = `
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (member_expression property: (property_identifier) @name)) @reference.call
(new_expression constructor: (identifier) @name) @reference.class
(import_specifier name: (identifier) @name) @reference.import
(import_clause (identifier) @name) @reference.import
`;

const JS_REFERENCES = `
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (member_expression property: (property_identifier) @name)) @reference.call
(new_expression constructor: (identifier) @name) @reference.class
(import_specifier name: (identifier) @name) @reference.import
(import_clause (identifier) @name) @reference.import
`;

function definitionsFor(dialect: Dialect): string {
  if (dialect === "javascript") return JS_DEFINITIONS;
  return TS_DEFINITIONS;
}

function referencesFor(dialect: Dialect): string {
  if (dialect === "javascript") return JS_REFERENCES;
  return TS_REFERENCES;
}

export interface SymbolQueries {
  definitions: Query;
  references: Query;
}

export function createQueries(language: Language, dialect: Dialect): SymbolQueries {
  return {
    definitions: new Query(language, definitionsFor(dialect)),
    references: new Query(language, referencesFor(dialect)),
  };
}

export function captureKind(captureName: string): "definition" | "reference" | "name" | "other" {
  if (captureName === "name") return "name";
  if (captureName.startsWith("definition.")) return "definition";
  if (captureName.startsWith("reference.")) return "reference";
  return "other";
}

export function definitionKind(captureName: string): string {
  return captureName.slice("definition.".length);
}

export function referenceType(captureName: string): "call" | "import" | "reference" | "class" {
  const suffix = captureName.slice("reference.".length);
  if (suffix === "call") return "call";
  if (suffix === "import") return "import";
  if (suffix === "class") return "class";
  return "reference";
}
