import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { theme } from "./theme.js";

type Block =
  | { type: "paragraph"; lines: string[] }
  | { type: "heading"; level: number; text: string }
  | { type: "code"; lang: string; body: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "blockquote"; lines: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "rule" };

type InlinePart =
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

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 2;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!isTableRow(trimmed)) return false;
  return trimmed
    .slice(1, -1)
    .split("|")
    .every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function plainTextLength(text: string): number {
  return parseInline(text).reduce((sum, part) => sum + part.value.length, 0);
}

function tableColumnWidths(headers: string[], rows: string[][]): number[] {
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

function Inline({ text }: { text: string }) {
  const parts = parseInline(text);
  return (
    <Text wrap="wrap">
      {parts.map((part, i) => {
        switch (part.kind) {
          case "bold":
            return (
              <Text key={i} bold color={theme.fg}>
                {part.value}
              </Text>
            );
          case "italic":
            return (
              <Text key={i} italic color={theme.fg}>
                {part.value}
              </Text>
            );
          case "code":
            return (
              <Text key={i} bold backgroundColor={theme.codeBg} color={theme.codeFg}>
                {` ${part.value} `}
              </Text>
            );
          default:
            return (
              <Text key={i} color={theme.fg}>
                {part.value}
              </Text>
            );
        }
      })}
    </Text>
  );
}

function TableRow({
  cells,
  widths,
  header = false,
}: {
  cells: string[];
  widths: number[];
  header?: boolean;
}) {
  return (
    <Text>
      <Text color={theme.border}>│ </Text>
      {cells.map((cell, index) => {
        const width = widths[index] ?? 3;
        const pad = Math.max(0, width - plainTextLength(cell));
        return (
          <Text key={index}>
            <Text bold={header} color={header ? theme.heading : theme.fg}>
              <Inline text={cell} />
            </Text>
            {" ".repeat(pad)}
            {index < cells.length - 1 ? (
              <Text color={theme.border}> │ </Text>
            ) : null}
          </Text>
        );
      })}
      <Text color={theme.border}> │</Text>
    </Text>
  );
}

function TableBlock({ headers, rows }: { headers: string[]; rows: string[][] }) {
  const widths = tableColumnWidths(headers, rows);
  const divider = `├${widths.map((w) => "─".repeat(w + 2)).join("┼")}┤`;
  const top = `┌${widths.map((w) => "─".repeat(w + 2)).join("┬")}┐`;
  const bottom = `└${widths.map((w) => "─".repeat(w + 2)).join("┴")}┘`;

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={theme.border}>{top}</Text>
      <TableRow cells={headers} widths={widths} header />
      <Text color={theme.border}>{divider}</Text>
      {rows.map((row, index) => (
        <TableRow key={index} cells={row} widths={widths} />
      ))}
      <Text color={theme.border}>{bottom}</Text>
    </Box>
  );
}

function renderBlock(block: Block, index: number): ReactNode {
  switch (block.type) {
    case "heading": {
      return (
        <Box key={index} marginTop={index > 0 ? 1 : 0} marginBottom={0}>
          <Text bold color={theme.heading} underline={block.level === 1}>
            {block.text}
          </Text>
        </Box>
      );
    }
    case "code":
      return (
        <Box
          key={index}
          flexDirection="column"
          marginY={1}
          paddingX={1}
          backgroundColor={theme.codeBg}
        >
          {block.body.split("\n").map((line, i) => (
            <Text key={i} bold color={theme.codeFg}>
              {line || " "}
            </Text>
          ))}
        </Box>
      );
    case "list":
      return (
        <Box key={index} flexDirection="column" marginY={0}>
          {block.items.map((item, i) => (
            <Text key={i} wrap="wrap">
              <Text bold color={theme.muted}>{block.ordered ? `${i + 1}. ` : "· "}</Text>
              <Inline text={item} />
            </Text>
          ))}
        </Box>
      );
    case "blockquote":
      return (
        <Box
          key={index}
          flexDirection="column"
          marginY={1}
          paddingLeft={1}
          borderStyle="single"
          borderColor={theme.border}
          borderLeft
          borderTop={false}
          borderBottom={false}
          borderRight={false}
        >
          {block.lines.map((line, i) => (
            <Inline key={i} text={line} />
          ))}
        </Box>
      );
    case "rule":
      return (
        <Box key={index} marginY={1}>
          <Text color={theme.border}>{"─".repeat(40)}</Text>
        </Box>
      );
    case "table":
      return (
        <Box key={index}>
          <TableBlock headers={block.headers} rows={block.rows} />
        </Box>
      );
    case "paragraph":
      return (
        <Box key={index} flexDirection="column">
          {block.lines.map((line, i) => (
            <Inline key={i} text={line} />
          ))}
        </Box>
      );
  }
}

export function Markdown({ content }: { content: string }) {
  if (!content.trim()) return null;
  const blocks = parseBlocks(content);
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => renderBlock(block, i))}
    </Box>
  );
}
