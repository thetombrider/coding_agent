import { z } from "zod";
import { loadToolDescription } from "../util/load-txt.js";
import { formatResults } from "../symbols/format.js";
import type { SymbolKind } from "../symbols/types.js";
import type { SearchMode } from "../symbols/types.js";
import { MAX_COMMAND_OUTPUT_BYTES, truncationNote } from "./output-limits.js";
import type { Tool } from "./types.js";

const symbolKindSchema = z.enum([
  "function",
  "method",
  "class",
  "interface",
  "variable",
  "constant",
  "module",
  "import",
  "export",
]);

const schema = z.object({
  query: z.string().describe("Symbol name or search prefix"),
  mode: z
    .enum(["definitions", "references", "callers", "search"])
    .optional()
    .describe('Lookup mode (default: "definitions")'),
  kind: symbolKindSchema.optional().describe("Filter by symbol kind"),
  file: z.string().optional().describe("Scope to a file or directory"),
  limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
});

export type SearchSymbolsArgs = z.infer<typeof schema>;

export const searchSymbolsTool: Tool<SearchSymbolsArgs> = {
  name: "search_symbols",
  description: loadToolDescription("search-symbols"),
  schema,
  async execute({ query, mode, kind, file, limit }, ctx) {
    const symbols = ctx.symbols;
    if (!symbols) {
      return { output: "Symbol index unavailable.", isError: true };
    }

    if (!symbols.ready) {
      try {
        await symbols.warmIndex(ctx.workspace, ctx.cwd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: msg, isError: true };
      }
    }

    const searchMode = (mode ?? "definitions") as SearchMode;
    const { symbols: syms, references: refs } = symbols.query(query, searchMode, {
      kind: kind as SymbolKind | undefined,
      file,
      limit,
    });

    let output = formatResults(syms, refs, symbols.allSymbols());
    if (Buffer.byteLength(output, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
      output = output.slice(0, MAX_COMMAND_OUTPUT_BYTES) + truncationNote(MAX_COMMAND_OUTPUT_BYTES);
    }
    return { output };
  },
};
