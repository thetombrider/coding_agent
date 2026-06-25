export const MAX_OUTPUT_DISPLAY_LINES = 200;

// When an expanded tool output is taller than this, it is rendered inside a
// fixed-height scrollable window instead of pushing the rest of the
// conversation off-screen. The user can scroll within that window.
export const MAX_EXPANDED_VIEW_ROWS = 16;

export function countOutputLines(output: string): number {
  const lines = output.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") return lines.length - 1;
  return lines.length;
}

export function formatToolOutputForDisplay(output: string): {
  lines: string[];
  totalLines: number;
  truncated: boolean;
  omittedLines: number;
} {
  const allLines = output.split("\n");
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }
  const totalLines = allLines.length;
  if (totalLines <= MAX_OUTPUT_DISPLAY_LINES) {
    return { lines: allLines, totalLines, truncated: false, omittedLines: 0 };
  }
  return {
    lines: allLines.slice(0, MAX_OUTPUT_DISPLAY_LINES),
    totalLines,
    truncated: true,
    omittedLines: totalLines - MAX_OUTPUT_DISPLAY_LINES,
  };
}

/** Show a line count in inline/footer hints once output reaches this size. */
export const EXPAND_HINT_LINE_COUNT_THRESHOLD = 10;

export function outputExpandHint(output: string): string {
  const lineCount = countOutputLines(output);
  if (lineCount <= 1) return "";
  if (lineCount < EXPAND_HINT_LINE_COUNT_THRESHOLD) return "▸";
  return `▸ ${lineCount} lines`;
}

export function formatHoverExpandFooter(
  label: string,
  output: string | undefined,
  expanded: boolean,
): string {
  if (expanded) return `${label} · expanded · c copy`;
  if (!output) return `${label} · click to expand`;
  const lineCount = countOutputLines(output);
  if (lineCount <= 1) return `${label} · click to expand`;
  return `${label} · ${lineCount} lines · click to expand`;
}
