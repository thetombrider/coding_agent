/** Pure markdown parsing (no rendering). Shared by the TUI renderer and tests. */

export type Block =
  | { type: "paragraph"; lines: string[] }
  | { type: "heading"; level: number; text: string }
  | { type: "code"; lang: string; body: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "blockquote"; lines: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "rule" };

export type InlinePart =
  | { kind: "text"; value: string }
  | { kind: "bold"; value: string }
  | { kind: "italic"; value: string }
  | { kind: "code"; value: string };

export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      blocks.push({ type: "code", lang, body: body.join("\n") });
      continue;
    }

    if (/^#{1,3}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      blocks.push({ type: "heading", level, text: line.replace(/^#+\s*/, "") });
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "blockquote", lines: quote });
      continue;
    }

    if (/^(\s*)[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^(\s*)[-*+]\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^(\s*)[-*+]\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\d+\.\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const headers = parseTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]!)) {
        rows.push(parseTableRow(lines[i]!));
        i += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    const para: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i]!.trim() !== "" && !isBlockStart(lines[i]!)) {
      para.push(lines[i]!);
      i += 1;
    }
    blocks.push({ type: "paragraph", lines: para });
  }

  return blocks;
}

function isBlockStart(line: string): boolean {
  return (
    /^```/.test(line)
    || /^#{1,3}\s/.test(line)
    || /^>\s?/.test(line)
    || /^(\s*)[-*+]\s+/.test(line)
    || /^\d+\.\s+/.test(line)
    || isTableRow(line)
    || /^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())
  );
}

export function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 2;
}

export function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!isTableRow(trimmed)) return false;
  return trimmed
    .slice(1, -1)
    .split("|")
    .every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

export function parseTableRow(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

export function plainTextLength(text: string): number {
  return parseInline(text).reduce((sum, part) => sum + part.value.length, 0);
}

export function tableColumnWidths(headers: string[], rows: string[][]): number[] {
  const count = headers.length;
  return Array.from({ length: count }, (_, col) => {
    const lengths = [
      plainTextLength(headers[col] ?? ""),
      ...rows.map((row) => plainTextLength(row[col] ?? "")),
    ];
    return Math.max(3, ...lengths);
  });
}

export function parseInline(source: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let rest = source;

  while (rest.length > 0) {
    const code = rest.match(/^`([^`]+)`/);
    if (code) {
      parts.push({ kind: "code", value: code[1]! });
      rest = rest.slice(code[0].length);
      continue;
    }

    const bold = rest.match(/^\*\*([^*]+)\*\*/) ?? rest.match(/^__([^_]+)__/);
    if (bold) {
      parts.push({ kind: "bold", value: bold[1]! });
      rest = rest.slice(bold[0].length);
      continue;
    }

    const italic = rest.match(/^\*([^*]+)\*/) ?? rest.match(/^_([^_]+)_/);
    if (italic) {
      parts.push({ kind: "italic", value: italic[1]! });
      rest = rest.slice(italic[0].length);
      continue;
    }

    const next = rest.search(/(`|\*\*|__|\*|_)/);
    if (next === -1) {
      parts.push({ kind: "text", value: rest });
      break;
    }
    if (next > 0) {
      parts.push({ kind: "text", value: rest.slice(0, next) });
      rest = rest.slice(next);
      continue;
    }

    parts.push({ kind: "text", value: rest[0]! });
    rest = rest.slice(1);
  }

  return parts;
}
