import { bold, createTextAttributes, fg, italic, StyledText, type TextChunk } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { For, Index, type JSX, Show } from "solid-js";
import {
  type Block,
  displayWidth,
  fitColumnWidths,
  type InlinePart,
  normalizeRow,
  parseBlocks,
  parseInline,
  tableColumnWidths,
  wrapInlineParts,
} from "./markdown-parse.js";
import { surfaceSelection, theme } from "./theme.js";

/**
 * Horizontal space the conversation column loses to chrome: the root box pads
 * 2 on each side and the scroll rail takes 1. Tables cap to the remainder so
 * wide content wraps inside cells instead of overflowing and shredding borders.
 */
const TABLE_CHROME = 5;

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
        return fg(theme.accent)(part.value);
      case "math":
        return fg(theme.fg)(italic(part.value));
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

/**
 * Inline chunks for one wrapped line of a table cell. Renders bold/italic/code
 * styling but keeps each chunk's width equal to its display width (no padding
 * around code), so column widths and the right border stay aligned. Header cells
 * are bold.
 */
function cellChunks(parts: InlinePart[], header: boolean): TextChunk[] {
  return parts.map((part) => {
    if (header) return fg(theme.heading)(bold(part.value));
    switch (part.kind) {
      case "bold":
        return fg(theme.fg)(bold(part.value));
      case "italic":
        return fg(theme.fg)(italic(part.value));
      case "code":
        return fg(theme.accent)(part.value);
      case "math":
        return fg(theme.fg)(italic(part.value));
      default:
        return fg(theme.fg)(part.value);
    }
  });
}

/** Build one physical row line: border + each column's wrapped line padded to its width. */
function rowLineText(cells: InlinePart[][], widths: number[], header: boolean): StyledText {
  const sep = (s: string) => fg(theme.border)(s);
  const chunks: TextChunk[] = [sep("│ ")];
  widths.forEach((width, index) => {
    const parts = cells[index] ?? [];
    const used = parts.reduce((sum, part) => sum + displayWidth(part.value), 0);
    chunks.push(...cellChunks(parts, header));
    chunks.push(fg(theme.fg)(" ".repeat(Math.max(0, width - used))));
    chunks.push(sep(index < widths.length - 1 ? " │ " : " │"));
  });
  return new StyledText(chunks);
}

/** Wrap a logical row across columns into the physical lines it spans. */
function rowLines(cells: string[], widths: number[], header: boolean): StyledText[] {
  const wrapped = widths.map((width, index) => wrapInlineParts(parseInline(cells[index] ?? ""), width));
  const height = Math.max(1, ...wrapped.map((lines) => lines.length));
  return Array.from({ length: height }, (_, line) =>
    rowLineText(wrapped.map((lines) => lines[line] ?? []), widths, header),
  );
}

function TableBlock(props: { headers: string[]; rows: string[][] }) {
  const dimensions = useTerminalDimensions();
  const columns = () => props.headers.length;
  const rows = () => props.rows.map((row) => normalizeRow(row, columns()));
  const widths = () => {
    const natural = tableColumnWidths(props.headers, rows());
    const available = dimensions().width - TABLE_CHROME;
    return available > 0 ? fitColumnWidths(natural, available) : natural;
  };
  const border = (left: string, mid: string, right: string) =>
    `${left}${widths().map((w) => "─".repeat(w + 2)).join(mid)}${right}`;

  return (
    <box flexDirection="column" marginTop={1} marginBottom={1}>
      <text selectable {...surfaceSelection(theme.bg)} fg={theme.border}>{border("┌", "┬", "┐")}</text>
      <For each={rowLines(props.headers, widths(), true)}>
        {(line) => <text selectable {...surfaceSelection(theme.bg)}>{styled(line)}</text>}
      </For>
      <text selectable {...surfaceSelection(theme.bg)} fg={theme.border}>{border("├", "┼", "┤")}</text>
      <For each={rows()}>
        {(row) => (
          <For each={rowLines(row, widths(), false)}>
            {(line) => <text selectable {...surfaceSelection(theme.bg)}>{styled(line)}</text>}
          </For>
        )}
      </For>
      <text selectable {...surfaceSelection(theme.bg)} fg={theme.border}>{border("└", "┴", "┘")}</text>
    </box>
  );
}

function BlockView(props: { block: Block; first: boolean }) {
  switch (props.block.type) {
    case "heading":
      return (
        <box marginTop={props.first ? 0 : 1}>
          <text
            selectable
            {...surfaceSelection(theme.bg, theme.heading)}
            fg={theme.heading}
            attributes={createTextAttributes({ bold: true, underline: props.block.level === 1 })}
          >
            {props.block.text}
          </text>
        </box>
      );
    case "code":
      return (
        <box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={1} paddingRight={1} backgroundColor={theme.codeBg}>
          <Index each={props.block.body.split("\n")}>
            {(line) => <text selectable {...surfaceSelection(theme.codeBg, theme.codeFg)} fg={theme.codeFg} attributes={BOLD}>{line() || " "}</text>}
          </Index>
        </box>
      );
    case "list": {
      const ordered = props.block.ordered;
      return (
        <box flexDirection="column">
          <Index each={props.block.items}>
            {(item, i) => (
              <text selectable {...surfaceSelection(theme.bg)} wrapMode="word">
                {styled(new StyledText([
                  fg(theme.muted)(bold(ordered ? `${i + 1}. ` : "· ")),
                  ...inlineChunks(item()),
                ]))}
              </text>
            )}
          </Index>
        </box>
      );
    }
    case "blockquote":
      return (
        <box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={1} border={["left"]} borderColor={theme.border}>
          <Index each={props.block.lines}>{(line) => <text selectable {...surfaceSelection(theme.bg)} wrapMode="word">{styled(inlineText(line()))}</text>}</Index>
        </box>
      );
    case "rule":
      return (
        <box marginTop={1} marginBottom={1}>
          <text fg={theme.border}>{"─".repeat(40)}</text>
        </box>
      );
    case "table":
      return <TableBlock headers={props.block.headers} rows={props.block.rows} />;
    case "paragraph":
      return (
        <box flexDirection="column">
          <Index each={props.block.lines}>{(line) => <text selectable {...surfaceSelection(theme.bg)} wrapMode="word">{styled(inlineText(line()))}</text>}</Index>
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
