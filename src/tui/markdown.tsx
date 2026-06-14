import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { theme } from "./theme.js";

type Block =
  | { type: "paragraph"; lines: string[] }
  | { type: "heading"; level: number; text: string }
  | { type: "code"; lang: string; body: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "blockquote"; lines: string[] }
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
    || /^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())
  );
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
