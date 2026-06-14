import type { Turn } from "./controller.js";

const TURN_GAP_LINES = 1;

/** Wrapped line count for plain text in a given terminal width. */
export function lineCount(text: string, width: number): number {
  if (!text) return 0;
  const cols = Math.max(1, width);
  return text.split("\n").reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(line.length / cols) || 1),
    0,
  );
}

export interface TurnLayout {
  turn: Turn;
  startLine: number;
  userLines: number;
  toolLineCounts: number[];
  assistantLines: number;
  totalLines: number;
}

export function layoutTurns(turns: Turn[], width: number): TurnLayout[] {
  let cursor = 0;
  const layouts: TurnLayout[] = [];

  for (const turn of turns) {
    const startLine = cursor;
    const userLines = turn.userText ? lineCount(turn.userText, width) + 1 : 0;
    const toolLineCounts = turn.tools.map((entry) => {
      let lines = 1;
      if (entry.status === "error" && entry.output) lines += 1;
      if (entry.name === "edit" && entry.status === "done" && entry.output?.includes("@@")) {
        lines += lineCount(entry.output, width);
      }
      return lines;
    });
    const assistantGap = turn.assistantText && turn.tools.length > 0 ? 1 : 0;
    const assistantLines = turn.assistantText
      ? lineCount(turn.assistantText, width) + assistantGap
      : 0;
    const bodyLines = userLines + toolLineCounts.reduce((a, b) => a + b, 0) + assistantLines;
    const totalLines = bodyLines > 0 ? bodyLines + TURN_GAP_LINES : 0;
    layouts.push({
      turn,
      startLine,
      userLines,
      toolLineCounts,
      assistantLines,
      totalLines,
    });
    cursor += totalLines;
  }

  return layouts;
}

export function totalContentLines(turns: Turn[], width: number): number {
  const layouts = layoutTurns(turns, width);
  if (layouts.length === 0) return 0;
  const last = layouts.at(-1)!;
  return last.startLine + last.totalLines;
}

export interface TurnViewSlice {
  showUser: boolean;
  toolIndices: number[];
  assistantStartLine: number;
  assistantEndLine: number | null;
}

export interface VisibleTurnSlice {
  turn: Turn;
  slice: TurnViewSlice;
}

export interface ContentWindow {
  slices: VisibleTurnSlice[];
  hiddenBeforeLines: number;
  hiddenAfterLines: number;
  viewportStartLine: number;
  totalLines: number;
}

export function sliceAssistantLines(
  text: string,
  startLine: number,
  endLine: number | null,
  width: number,
): string {
  if (!text || startLine <= 0 && endLine === null) return text;
  const cols = Math.max(1, width);
  const wrapped: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= cols) {
      wrapped.push(line);
      continue;
    }
    for (let i = 0; i < line.length; i += cols) {
      wrapped.push(line.slice(i, i + cols));
    }
  }
  return wrapped.slice(startLine, endLine ?? undefined).join("\n");
}

function intersectSlice(
  layout: TurnLayout,
  windowStart: number,
  windowEnd: number,
): VisibleTurnSlice | null {
  const turnEnd = layout.startLine + layout.totalLines;
  if (turnEnd <= windowStart || layout.startLine >= windowEnd) return null;

  let offset = layout.startLine;
  const slice: TurnViewSlice = {
    showUser: false,
    toolIndices: [],
    assistantStartLine: 0,
    assistantEndLine: null,
  };

  if (layout.userLines > 0) {
    const userEnd = offset + layout.userLines;
    if (userEnd > windowStart && offset < windowEnd) slice.showUser = true;
    offset = userEnd;
  }

  for (let i = 0; i < layout.toolLineCounts.length; i += 1) {
    const count = layout.toolLineCounts[i]!;
    const toolEnd = offset + count;
    if (toolEnd > windowStart && offset < windowEnd) slice.toolIndices.push(i);
    offset = toolEnd;
  }

  if (layout.assistantLines > 0) {
    const assistantEnd = offset + layout.assistantLines;
    if (assistantEnd > windowStart && offset < windowEnd) {
      const relStart = Math.max(0, windowStart - offset);
      const relEnd = Math.min(layout.assistantLines, windowEnd - offset);
      slice.assistantStartLine = relStart;
      slice.assistantEndLine = relEnd < layout.assistantLines ? relEnd : null;
    }
  }

  const hasAssistant =
    layout.assistantLines > 0
    && (slice.assistantEndLine === null || slice.assistantEndLine > slice.assistantStartLine);

  const hasContent = slice.showUser || slice.toolIndices.length > 0 || hasAssistant;

  if (!hasContent) return null;

  return { turn: layout.turn, slice };
}

/** Line-anchored viewport. When followTail, stick to bottom; otherwise keep viewportStartLine fixed while content grows. */
export function visibleContentWindow(
  completed: Turn[],
  current: Turn | null,
  viewportLines: number,
  width: number,
  followTail: boolean,
  anchorLine: number | null,
): ContentWindow {
  const all = current ? [...completed, current] : completed;
  const layouts = layoutTurns(all, width);
  const totalLines = layouts.length === 0
    ? 0
    : layouts.at(-1)!.startLine + layouts.at(-1)!.totalLines;

  if (totalLines === 0) {
    return {
      slices: [],
      hiddenBeforeLines: 0,
      hiddenAfterLines: 0,
      viewportStartLine: 0,
      totalLines: 0,
    };
  }

  const maxStart = Math.max(0, totalLines - viewportLines);
  const viewportStartLine = followTail
    ? maxStart
    : Math.min(Math.max(0, anchorLine ?? 0), maxStart);
  const viewportEndLine = Math.min(totalLines, viewportStartLine + viewportLines);

  const slices: VisibleTurnSlice[] = [];
  for (const layout of layouts) {
    const piece = intersectSlice(layout, viewportStartLine, viewportEndLine);
    if (piece) slices.push(piece);
  }

  return {
    slices,
    hiddenBeforeLines: viewportStartLine,
    hiddenAfterLines: Math.max(0, totalLines - viewportEndLine),
    viewportStartLine,
    totalLines,
  };
}

/** @deprecated turn-based window; prefer visibleContentWindow */
export function visibleTurnWindow(
  completed: Turn[],
  current: Turn | null,
  scrollTurnsFromEnd: number,
  maxVisible: number,
): { turns: Turn[]; hiddenBefore: number; hiddenAfter: number } {
  const all = current ? [...completed, current] : completed;
  if (all.length === 0) {
    return { turns: [], hiddenBefore: 0, hiddenAfter: 0 };
  }

  const clampedScroll = Math.min(Math.max(0, scrollTurnsFromEnd), Math.max(0, all.length - 1));
  const end = all.length - clampedScroll;
  const start = Math.max(0, end - maxVisible);

  return {
    turns: all.slice(start, end),
    hiddenBefore: start,
    hiddenAfter: clampedScroll,
  };
}

export function maxVisibleTurns(bodyRows: number): number {
  return Math.max(2, Math.floor(bodyRows / 5));
}

export function messageBodyRows(totalRows: number): number {
  const headerRows = 2;
  const inputRows = 4;
  const padding = 2;
  return Math.max(6, totalRows - headerRows - inputRows - padding);
}

export function scrollStartLine(
  followTail: boolean,
  anchorLine: number | null,
  totalLines: number,
  viewportLines: number,
): number {
  const maxStart = Math.max(0, totalLines - viewportLines);
  if (followTail) return maxStart;
  return Math.min(Math.max(0, anchorLine ?? 0), maxStart);
}
