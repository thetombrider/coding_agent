export const MAX_OUTPUT_DISPLAY_LINES = 200;

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

export function outputExpandHint(output: string): string {
  const lineCount = countOutputLines(output);
  if (lineCount <= 1) return "▸ expand";
  return `▸ ${lineCount} lines`;
}
