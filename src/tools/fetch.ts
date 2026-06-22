import { z } from "zod";
import { htmlToMarkdown, htmlToText } from "../util/html-to-markdown.js";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

const MAX_OUTPUT_BYTES = 100 * 1024;

const schema = z.object({
  url: z.string().describe("HTTP or HTTPS URL to fetch"),
  format: z
    .enum(["markdown", "text", "html"])
    .optional()
    .describe("Output format (default: markdown)"),
});

export type FetchArgs = z.infer<typeof schema>;
export type FetchFormat = NonNullable<FetchArgs["format"]>;

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") {
    return true;
  }
  if (host.startsWith("10.") || host.startsWith("192.168.")) {
    return true;
  }
  return /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host);
}

export function validateFetchUrl(url: string): URL | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `Invalid URL: ${url}` };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { error: `Invalid URL protocol "${parsed.protocol}". Only http: and https: are supported.` };
  }

  if (isPrivateHostname(parsed.hostname)) {
    return { error: `Cannot fetch from internal/private network address: ${parsed.hostname}` };
  }

  return parsed;
}

function looksLikeHtml(contentType: string | null, body: string): boolean {
  if (contentType?.includes("text/html")) return true;
  const trimmed = body.trimStart();
  return trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html") || trimmed.startsWith("<");
}

export function formatFetchedBody(
  body: string,
  contentType: string | null,
  format: FetchFormat,
): string {
  if (format === "html") return body;
  if (format === "text") {
    return looksLikeHtml(contentType, body) ? htmlToText(body) : body;
  }
  if (looksLikeHtml(contentType, body)) return htmlToMarkdown(body);
  return body;
}

export function truncateOutput(text: string, maxBytes = MAX_OUTPUT_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  const suffix = `\n\n[Content truncated - original size was ${text.length} characters]`;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const contentBudget = Math.max(0, maxBytes - suffixBytes);

  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > contentBudget) {
    end -= 1;
  }

  return `${text.slice(0, end)}${suffix}`;
}

export const fetchTool: Tool<FetchArgs> = {
  name: "fetch",
  description: loadToolDescription("fetch"),
  schema,
  needsApproval: () => false,
  async execute({ url, format = "markdown" }, _ctx, signal) {
    const validated = validateFetchUrl(url);
    if ("error" in validated) {
      return { output: validated.error, isError: true };
    }

    let response: Response;
    try {
      response = await fetch(validated.toString(), { signal });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Failed to fetch URL: ${message}`, isError: true };
    }

    if (!response.ok) {
      return {
        output: `HTTP ${response.status} ${response.statusText} for ${url}`,
        isError: true,
      };
    }

    const body = await response.text();
    const contentType = response.headers.get("content-type");
    const formatted = formatFetchedBody(body, contentType, format);
    return { output: truncateOutput(formatted) };
  },
};
