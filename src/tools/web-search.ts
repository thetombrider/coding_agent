import { z } from "zod";
import { getExaApiKey } from "../config/config.js";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 10;
/** Output is capped so search results cannot blow up the model's context. */
const MAX_OUTPUT = 100 * 1024;

const categorySchema = z.enum([
  "company",
  "people",
  "research paper",
  "news",
  "personal site",
  "financial report",
]);

const schema = z.object({
  query: z.string().describe("Natural language search query"),
  numResults: z
    .number()
    .int()
    .min(1)
    .max(MAX_NUM_RESULTS)
    .optional()
    .describe(`Number of results to return (default ${DEFAULT_NUM_RESULTS}, max ${MAX_NUM_RESULTS})`),
  category: categorySchema
    .optional()
    .describe("Optional content category filter (company, news, research paper, etc.)"),
});

export type WebSearchArgs = z.infer<typeof schema>;

interface ExaSearchResult {
  title?: string | null;
  url?: string | null;
  publishedDate?: string | null;
  author?: string | null;
  highlights?: string[] | null;
  summary?: string | null;
  text?: string | null;
}

interface ExaSearchResponse {
  results?: ExaSearchResult[];
  output?: { content?: unknown };
}

export function formatExaResults(results: ExaSearchResult[]): string {
  if (results.length === 0) return "No results found.";

  const blocks = results.map((result, index) => {
    const lines: string[] = [`## ${index + 1}. ${result.title?.trim() || "(untitled)"}`];
    if (result.url) lines.push(result.url);
    if (result.publishedDate) lines.push(`Published: ${result.publishedDate}`);
    if (result.author) lines.push(`Author: ${result.author}`);

    const highlights = result.highlights?.map((h) => h.trim()).filter(Boolean) ?? [];
    if (highlights.length > 0) {
      lines.push("", ...highlights.map((h) => `- ${h}`));
    } else if (result.summary?.trim()) {
      lines.push("", result.summary.trim());
    } else if (result.text?.trim()) {
      lines.push("", result.text.trim());
    }

    return lines.join("\n");
  });

  return blocks.join("\n\n");
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return `${s.slice(0, MAX_OUTPUT)}\n\n[truncated at ${MAX_OUTPUT} bytes]`;
}

export const webSearchTool: Tool<WebSearchArgs> = {
  name: "web_search",
  description: loadToolDescription("web-search"),
  schema,
  needsApproval: () => false,
  async execute({ query, numResults, category }, _ctx, signal) {
    const apiKey = getExaApiKey();
    if (!apiKey) {
      return {
        output:
          "Exa is not configured. Set tools.exa.apiKey in ~/.orin/config.json "
          + "(run /settings exa in the TUI).",
        isError: true,
      };
    }

    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return { output: "Query must not be empty.", isError: true };
    }

    const body: Record<string, unknown> = {
      query: trimmedQuery,
      type: "auto",
      numResults: numResults ?? DEFAULT_NUM_RESULTS,
      contents: { highlights: true },
    };
    if (category) body.category = category;

    let res: Response;
    try {
      res = await fetch(EXA_SEARCH_URL, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return { output: `Web search failed: ${(err as Error).message}`, isError: true };
    }

    const raw = await res.text();
    if (!res.ok) {
      const detail = raw.trim() ? `: ${raw.trim().slice(0, 500)}` : "";
      return { output: `Exa search failed (HTTP ${res.status})${detail}`, isError: true };
    }

    let parsed: ExaSearchResponse;
    try {
      parsed = JSON.parse(raw) as ExaSearchResponse;
    } catch {
      return { output: "Exa search returned invalid JSON.", isError: true };
    }

    const results = parsed.results ?? [];
    const formatted = formatExaResults(results);
    const synthesized =
      typeof parsed.output?.content === "string" ? parsed.output.content.trim() : "";
    const output = synthesized ? `${synthesized}\n\n---\n\n${formatted}` : formatted;
    return { output: truncate(output) };
  },
};
