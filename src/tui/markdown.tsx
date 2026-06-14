import { bg, bold, createTextAttributes, fg, italic, StyledText, type TextChunk } from "@opentui/core";
import { For, type JSX, Show } from "solid-js";
import {
  type Block,
  parseBlocks,
  parseInline,
  plainTextLength,
  tableColumnWidths,
} from "./markdown-parse.js";
import { theme } from "./theme.js";

const BOLD = createTextAttributes({ bold: true });

/** Convert inline markdown to styled text chunks. */
function inlineChunks(text: string): TextChunk[] {
  return parseInline(text).map((part) => {
    switch (part.kind) {
      case "bold":
        return fg(theme.fg)(bold(part.value));
      case "italic":
        return fg(theme.fg)(italic(part.value));
      case "code":
        return bg(theme.codeBg)(fg(theme.codeFg)(bold(` ${part.value} `)));
      default:
        return fg(theme.fg)(part.value);
    }
  });
}

function inlineText(text: string): StyledText {
  return new StyledText(inlineChunks(text));
}

/**
 * Render a StyledText as a <text> child. OpenTUI renders styled runs passed as
 * children (the `content` prop stringifies them), but the children type doesn't
 * include StyledText, so bridge it here.
 */
function styled(node: StyledText): JSX.Element {
  return node as unknown as JSX.Element;
}

function rowText(cells: string[], widths: number[], header: boolean): StyledText {
  const sep = (s: string) => fg(theme.border)(s);
  const chunks: TextChunk[] = [sep("│ ")];
  cells.forEach((cell, index) => {
    const color = header ? theme.heading : theme.fg;
    chunks.push(header ? fg(color)(bold(cell)) : fg(color)(cell));
    chunks.push(fg(color)(" ".repeat(Math.max(0, (widths[index] ?? 3) - plainTextLength(cell)))));
    chunks.push(sep(index < cells.length - 1 ? " │ " : " │"));
  });
  return new StyledText(chunks);
}

function TableBlock(props: { headers: string[]; rows: string[][] }) {
  const widths = () => tableColumnWidths(props.headers, props.rows);
  const top = () => `┌${widths().map((w) => "─".repeat(w + 2)).join("┬")}┐`;
  const divider = () => `├${widths().map((w) => "─".repeat(w + 2)).join("┼")}┤`;
  const bottom = () => `└${widths().map((w) => "─".repeat(w + 2)).join("┴")}┘`;

  return (
    <box flexDirection="column" marginTop={1} marginBottom={1}>
      <text fg={theme.border}>{top()}</text>
      <text>{styled(rowText(props.headers, widths(), true))}</text>
      <text fg={theme.border}>{divider()}</text>
      <For each={props.rows}>{(row) => <text>{styled(rowText(row, widths(), false))}</text>}</For>
      <text fg={theme.border}>{bottom()}</text>
    </box>
  );
}

function BlockView(props: { block: Block; first: boolean }) {
  const block = props.block;
  switch (block.type) {
    case "heading":
      return (
        <box marginTop={props.first ? 0 : 1}>
          <text
            fg={theme.heading}
            attributes={createTextAttributes({ bold: true, underline: block.level === 1 })}
          >
            {block.text}
          </text>
        </box>
      );
    case "code":
      return (
        <box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={1} paddingRight={1} backgroundColor={theme.codeBg}>
          <For each={block.body.split("\n")}>
            {(line) => <text fg={theme.codeFg} attributes={BOLD}>{line || " "}</text>}
          </For>
        </box>
      );
    case "list":
      return (
        <box flexDirection="column">
          <For each={block.items}>
            {(item, i) => (
              <text wrapMode="word">
                {styled(new StyledText([
                  fg(theme.muted)(bold(block.ordered ? `${i() + 1}. ` : "· ")),
                  ...inlineChunks(item),
                ]))}
              </text>
            )}
          </For>
        </box>
      );
    case "blockquote":
      return (
        <box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={1} border={["left"]} borderColor={theme.border}>
          <For each={block.lines}>{(line) => <text wrapMode="word">{styled(inlineText(line))}</text>}</For>
        </box>
      );
    case "rule":
      return (
        <box marginTop={1} marginBottom={1}>
          <text fg={theme.border}>{"─".repeat(40)}</text>
        </box>
      );
    case "table":
      return <TableBlock headers={block.headers} rows={block.rows} />;
    case "paragraph":
      return (
        <box flexDirection="column">
          <For each={block.lines}>{(line) => <text wrapMode="word">{styled(inlineText(line))}</text>}</For>
        </box>
      );
  }
}

export function Markdown(props: { content: string }) {
  const blocks = () => parseBlocks(props.content);
  return (
    <Show when={props.content.trim().length > 0}>
      <box flexDirection="column">
        <For each={blocks()}>{(block, i) => <BlockView block={block} first={i() === 0} />}</For>
      </box>
    </Show>
  );
}
