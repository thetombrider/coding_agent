const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITY_MAP[entity.toLowerCase()] ?? match;
  });
}

function stripInlineTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, "").trim());
}

/** Convert common HTML tags to readable markdown. */
export function htmlToMarkdown(html: string): string {
  let text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => {
    const hashes = "#".repeat(Number(level));
    return `${hashes} ${stripInlineTags(inner)}\n\n`;
  });

  text = text.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href: string, inner: string) => `[${stripInlineTags(inner)}](${href})`,
  );

  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<p\b[^>]*>/gi, "");
  text = text.replace(/<\/li>/gi, "\n");
  text = text.replace(/<li\b[^>]*>/gi, "- ");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeHtmlEntities(text);

  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** Strip all HTML tags and decode entities. */
export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}
