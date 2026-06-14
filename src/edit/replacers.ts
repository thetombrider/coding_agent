export type MatchResult = { start: number; end: number };
export type Matcher = (content: string, oldText: string) => MatchResult | null;

// Normalize oldText: strip leading/trailing blank lines added by the model
function stripBoundaryNewlines(s: string): string {
  return s.replace(/^\n+/, "").replace(/\n+$/, "");
}

// Compute character offsets for a window of content lines [startLine, startLine+lineCount)
// Lines are the result of content.split('\n')
function computeLineOffsets(
  lines: string[],
  startLine: number,
  lineCount: number,
): MatchResult {
  let start = 0;
  for (let i = 0; i < startLine; i++) start += lines[i]!.length + 1; // +1 for '\n'
  let end = start;
  for (let i = startLine; i < startLine + lineCount; i++) {
    end += lines[i]!.length;
    if (i < startLine + lineCount - 1) end += 1; // '\n' between lines
  }
  return { start, end };
}

// Generic line-based matcher: splits content and needle by '\n', applies normLine to each
// line before comparing. Finds the unique window in content that matches needle.
function matchLines(
  content: string,
  oldText: string,
  normLine: (line: string) => string,
): MatchResult | null {
  const needle = stripBoundaryNewlines(oldText);
  if (!needle) return null;

  const needleLines = needle.split("\n");
  const contentLines = content.split("\n");
  if (contentLines.length < needleLines.length) return null;

  const normNeedle = needleLines.map(normLine);
  const normContent = contentLines.map(normLine);

  let matchStart = -1;
  let matchCount = 0;

  outer: for (let i = 0; i <= contentLines.length - needleLines.length; i++) {
    for (let j = 0; j < needleLines.length; j++) {
      if (normContent[i + j] !== normNeedle[j]) continue outer;
    }
    matchCount++;
    if (matchCount === 1) matchStart = i;
    else return null; // ambiguous
  }

  if (matchStart === -1) return null;
  return computeLineOffsets(contentLines, matchStart, needleLines.length);
}

// ── Matcher 1: Simple ────────────────────────────────────────────────────────
// Exact string match after stripping leading/trailing newlines from oldText.
export const simpleMatch: Matcher = (content, oldText) => {
  const needle = stripBoundaryNewlines(oldText);
  if (!needle) return null;
  const idx = content.indexOf(needle);
  if (idx === -1) return null;
  if (content.indexOf(needle, idx + 1) !== -1) return null; // multiple
  return { start: idx, end: idx + needle.length };
};

// ── Matcher 2: LineTrimmed ───────────────────────────────────────────────────
// Trim trailing whitespace from each line before comparing.
export const lineTrimmedMatch: Matcher = (content, oldText) =>
  matchLines(content, oldText, (l) => l.trimEnd());

// ── Matcher 3: BlockAnchor ───────────────────────────────────────────────────
// Verify first/last lines as anchors (trimEnd), interior compared with full trim().
// Catches cases where the model adds leading/trailing spaces on interior lines.
export const blockAnchorMatch: Matcher = (content, oldText) => {
  const needle = stripBoundaryNewlines(oldText);
  if (!needle) return null;

  const needleLines = needle.split("\n");
  if (needleLines.length < 2) return matchLines(content, oldText, (l) => l.trim());

  const firstAnchor = needleLines[0]!.trimEnd();
  const lastAnchor = needleLines[needleLines.length - 1]!.trimEnd();
  const contentLines = content.split("\n");
  const n = needleLines.length;

  let matchStart = -1;
  let matchCount = 0;

  outer: for (let i = 0; i <= contentLines.length - n; i++) {
    if (contentLines[i]!.trimEnd() !== firstAnchor) continue;
    if (contentLines[i + n - 1]!.trimEnd() !== lastAnchor) continue;
    for (let j = 1; j < n - 1; j++) {
      if (contentLines[i + j]!.trim() !== needleLines[j]!.trim()) continue outer;
    }
    matchCount++;
    if (matchCount === 1) matchStart = i;
    else return null;
  }

  if (matchStart === -1) return null;
  return computeLineOffsets(contentLines, matchStart, n);
};

// ── Matcher 4: WhitespaceNormalized ─────────────────────────────────────────
// Collapse runs of spaces/tabs to a single space on each line before comparing.
export const whitespaceNormalizedMatch: Matcher = (content, oldText) =>
  matchLines(content, oldText, (l) => l.replace(/[ \t]+/g, " ").trim());

// ── Matcher 5: IndentationFlexible ──────────────────────────────────────────
// Strip ALL leading whitespace from each line — matches regardless of indent level.
export const indentationFlexibleMatch: Matcher = (content, oldText) =>
  matchLines(content, oldText, (l) => l.trimStart());

// ── Matcher 6: EscapeNormalized ─────────────────────────────────────────────
// Resolve common escape sequences before comparing (model may render them).
function normalizeEscapes(line: string): string {
  return line
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export const escapeNormalizedMatch: Matcher = (content, oldText) =>
  matchLines(content, oldText, normalizeEscapes);

// ── Matcher 7: Levenshtein ───────────────────────────────────────────────────
// Nuclear option: find the window of lines with minimum edit distance to oldText.
// Only applies if the best distance is ≤ 20% of needle length and is unique.
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // Space-optimized: two rows
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]!
          : 1 + Math.min(prev[j]!, curr[j - 1]!, prev[j - 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

export const levenshteinMatch: Matcher = (content, oldText) => {
  const needle = stripBoundaryNewlines(oldText);
  if (!needle) return null;

  const needleLines = needle.split("\n");
  const contentLines = content.split("\n");
  const n = contentLines.length;
  const m = needleLines.length;
  if (n < m) return null;

  const normNeedle = needleLines.join("\n");
  const threshold = Math.ceil(normNeedle.length * 0.2);

  let bestDist = Infinity;
  let bestI = -1;

  for (let i = 0; i <= n - m; i++) {
    const window = contentLines.slice(i, i + m).join("\n");
    const dist = levenshteinDistance(window, normNeedle);
    if (dist < bestDist) {
      bestDist = dist;
      bestI = i;
    }
  }

  if (bestI === -1 || bestDist > threshold) return null;

  // Require the best match to be unique (no other window at same distance)
  let ties = 0;
  for (let i = 0; i <= n - m; i++) {
    const window = contentLines.slice(i, i + m).join("\n");
    if (levenshteinDistance(window, normNeedle) === bestDist) ties++;
    if (ties > 1) return null;
  }

  return computeLineOffsets(contentLines, bestI, m);
};

// ── Chain ────────────────────────────────────────────────────────────────────
export const MATCHERS: Array<{ name: string; fn: Matcher }> = [
  { name: "exact match", fn: simpleMatch },
  { name: "line-trimmed match", fn: lineTrimmedMatch },
  { name: "block-anchor match", fn: blockAnchorMatch },
  { name: "whitespace-normalized match", fn: whitespaceNormalizedMatch },
  { name: "indentation-flexible match", fn: indentationFlexibleMatch },
  { name: "escape-normalized match", fn: escapeNormalizedMatch },
  { name: "Levenshtein match", fn: levenshteinMatch },
];

export function findMatch(content: string, oldText: string): MatchResult {
  for (const { fn } of MATCHERS) {
    const result = fn(content, oldText);
    if (result) return result;
  }
  const names = MATCHERS.map((m) => m.name).join(", ");
  throw new Error(
    `edit failed: could not find the text to replace. ` +
      `Tried ${names}. ` +
      `The oldText may not appear in the file, or it appears multiple times. ` +
      `Consider using grep to verify the current content.`,
  );
}
