import { z } from "zod";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

/** Output is capped so a large page cannot blow up the model's context. */
const MAX_OUTPUT = 100 * 1024;

const schema = z.object({
  url: z.string().describe("The http(s) URL to fetch"),
  format: z
    .enum(["markdown", "text", "html"])
    .optional()
    .describe("Output format for HTML pages (default: markdown)"),
});

export type FetchArgs = z.infer<typeof schema>;

/**
 * Block SSRF targets: loopback, unspecified, RFC-1918 private ranges, and
 * link-local (which covers cloud metadata endpoints). Hostname-string based,
 * matching nanocoder's `fetch_url` guard — DNS rebinding is out of scope.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "" || host === "::" || host === "::1") return true;

  // Normalize IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) down to the IPv4 part.
  const ipv4 = host.startsWith("::ffff:") ? host.slice("::ffff:".length) : host;
  const m = ipv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 127) return true; // unspecified / loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  return false;
}

export const fetchTool: Tool<FetchArgs> = {
  name: "fetch",
  description: loadToolDescription("fetch"),
  schema,
  needsApproval: () => false,
  async execute({ url, format }, _ctx, signal) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { output: `Invalid URL: ${url}`, isError: true };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { output: `Refusing non-http(s) URL scheme: ${parsed.protocol}`, isError: true };
    }
    if (isBlockedHost(parsed.hostname)) {
      return {
        output: `Refusing to fetch private/loopback host: ${parsed.hostname}`,
        isError: true,
      };
    }

    let res: Response;
    try {
      res = await fetch(url, {
        signal,
        headers: { "user-agent": "orin-agent", accept: "text/html,text/plain,*/*" },
      });
    } catch (err) {
      return { output: `Fetch failed: ${(err as Error).message}`, isError: true };
    }

    // Re-check after redirects so a public URL can't bounce us to a private host.
    if (res.url) {
      try {
        if (isBlockedHost(new URL(res.url).hostname)) {
          return {
            output: `Refusing redirect to private/loopback host: ${res.url}`,
            isError: true,
          };
        }
      } catch {
        /* unparseable final URL — fall through */
      }
    }

    if (!res.ok) {
      return { output: `HTTP ${res.status} ${res.statusText} for ${url}`, isError: true };
    }

    const raw = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    const fmt = format ?? "markdown";
    const looksHtml = /html/i.test(contentType) || /<html[\s>]|<!doctype html/i.test(raw);

    let out: string;
    if (fmt === "html" || !looksHtml) {
      out = raw;
    } else if (fmt === "text") {
      out = htmlToText(raw);
    } else {
      out = htmlToMarkdown(raw);
    }

    return { output: truncate(out) };
  },
};

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return `${s.slice(0, MAX_OUTPUT)}\n\n[truncated at ${MAX_OUTPUT} bytes]`;
}

function stripNonContent(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)));
}

function safeCodePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/** Flatten inline markup to a single trimmed line of text. */
function inlineText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function collapse(s: string): string {
  return s
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToText(html: string): string {
  const body = stripNonContent(html)
    .replace(/<br\s*\/?>(?!\n)/gi, "\n")
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|ul|ol|table|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return collapse(decodeEntities(body));
}

function htmlToMarkdown(html: string): string {
  let s = stripNonContent(html);
  s = s.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, lvl, inner) => `\n\n${"#".repeat(Number(lvl))} ${inlineText(inner)}\n\n`,
  );
  s = s.replace(
    /<a\b[^>]*\bhref=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, inner) => `[${inlineText(inner) || href}](${href})`,
  );
  s = s.replace(
    /<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_, _tag, inner) => `**${inlineText(inner)}**`,
  );
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, inner) => `*${inlineText(inner)}*`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => `\`${inlineText(inner)}\``);
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${inlineText(inner)}`);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|section|article|tr|ul|ol|table)>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, "");
  return collapse(decodeEntities(s));
}
