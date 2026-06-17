export type MatchResult = { start: number; end: number };
export type Matcher = (content: string, oldText: string) => MatchResult | null;

export type FindMatchOptions = {
  /** 1-indexed line hint to disambiguate non-unique oldText. */
  startLine?: number;
  /** Minimum normalized similarity (0–1) for middle-out fuzzy search. Default 0.8. */
  similarityThreshold?: number;
};

export type EditMismatchDetails = {
  oldText: string;
  similarity: number;
  closestCandidate: string;
  closestLine: number;
  context: string;
  triedMatchers: string[];
};

export class EditMismatchError extends Error {
  readonly details: EditMismatchDetails;

  constructor(details: EditMismatchDetails) {
    super(formatEditMismatchMessage(details));
    this.name = "EditMismatchError";
    this.details = details;
  }
}

export function formatEditMismatchMessage(d: EditMismatchDetails): string {
  const pct = Math.round(d.similarity * 100);
  return (
    `edit failed: could not find the text to replace.\n` +
    `Closest match (${pct}% similar) at line ${d.closestLine}:\n` +
    `${d.context}\n` +
    `Tried: ${d.triedMatchers.join(", ")}.\n` +
    `Use grep to verify the current content, or add a startLine hint to disambiguate.`
  );
}

const START_LINE_RE = /^:start_line:(\d+)\n?/;
const ANCHOR_BUFFER = 50;
const CONTEXT_LINES = 3;
const DEFAULT_SIMILARITY_THRESHOLD = 0.8;

// Normalize oldText: strip leading/trailing blank lines added by the model
function stripBoundaryNewlines(s: string): string {
  return s.replace(/^\n+/, "").replace(/\n+$/, "");
}

export function parseStartLineHint(oldText: string): { text: string; startLine?: number } {
  const m = oldText.match(START_LINE_RE);
  if (!m) return { text: oldText };
  return { text: oldText.slice(m[0].length), startLine: parseInt(m[1]!, 10) };
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

function surroundingContext(lines: string[], lineIdx: number, lineCount: number): string {
  const start = Math.max(0, lineIdx - CONTEXT_LINES);
  const end = Math.min(lines.length, lineIdx + lineCount + CONTEXT_LINES);
  return lines
    .slice(start, end)
    .map((line, i) => {
      const num = start + i + 1;
      const marker = num >= lineIdx + 1 && num <= lineIdx + lineCount ? ">" : " ";
      return `${marker} ${String(num).padStart(4)} | ${line}`;
    })
    .join("\n");
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

// Like matchLines but only considers matches within [rangeStartLine, rangeEndLine).
function matchLinesInRange(
  content: string,
  oldText: string,
  rangeStartLine: number,
  rangeEndLine: number,
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
  const maxStart = Math.min(contentLines.length - needleLines.length, rangeEndLine - needleLines.length);

  outer: for (let i = rangeStartLine; i <= maxStart; i++) {
    if (i < rangeStartLine) continue;
    for (let j = 0; j < needleLines.length; j++) {
      if (normContent[i + j] !== normNeedle[j]) continue outer;
    }
    matchCount++;
    if (matchCount === 1) matchStart = i;
    else return null;
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

export function normalizedSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
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

// ── Matcher 8: Line-number anchor ────────────────────────────────────────────
// Try exact match at the hinted line, then search a buffered window around it.
// Disambiguates non-unique oldText when a startLine hint is provided.
const ANCHORED_MATCHERS: Array<{ name: string; norm: (line: string) => string }> = [
  { name: "exact", norm: (l) => l },
  { name: "line-trimmed", norm: (l) => l.trimEnd() },
  { name: "indentation-flexible", norm: (l) => l.trimStart() },
  { name: "whitespace-normalized", norm: (l) => l.replace(/[ \t]+/g, " ").trim() },
];

export function anchorMatch(
  content: string,
  oldText: string,
  startLine: number,
): MatchResult | null {
  const needle = stripBoundaryNewlines(oldText);
  if (!needle) return null;

  const needleLines = needle.split("\n");
  const contentLines = content.split("\n");
  const hint = startLine - 1;
  if (hint < 0 || hint >= contentLines.length) return null;

  // 1. Try exact match at the hinted line first
  if (hint + needleLines.length <= contentLines.length) {
    const atHint = contentLines.slice(hint, hint + needleLines.length).join("\n");
    if (atHint === needle) {
      return computeLineOffsets(contentLines, hint, needleLines.length);
    }
  }

  // 2. Expand to a buffered window around the hint
  const buffer = Math.max(ANCHOR_BUFFER, needleLines.length * 3);
  const rangeStart = Math.max(0, hint - buffer);
  const rangeEnd = Math.min(contentLines.length, hint + buffer + needleLines.length);

  for (const { norm } of ANCHORED_MATCHERS) {
    const result = matchLinesInRange(content, oldText, rangeStart, rangeEnd, norm);
    if (result) return result;
  }

  return null;
}

// ── Matcher 9: Middle-out fuzzy ──────────────────────────────────────────────
// Search outward from the file midpoint, scoring by normalized Levenshtein similarity.
export function middleOutFuzzyMatch(
  content: string,
  oldText: string,
  threshold = DEFAULT_SIMILARITY_THRESHOLD,
): MatchResult | null {
  const needle = stripBoundaryNewlines(oldText);
  if (!needle) return null;

  const needleLines = needle.split("\n");
  const contentLines = content.split("\n");
  const m = needleLines.length;
  const n = contentLines.length;
  if (n < m) return null;

  const normNeedle = needleLines.join("\n");
  const searchable = n - m;
  const mid = Math.floor(searchable / 2);

  // Build middle-out search order over valid start indices [0, searchable]
  const order: number[] = [];
  for (let offset = 0; offset <= searchable; offset++) {
    order.push(mid + offset);
    if (offset > 0) order.push(mid - offset);
  }

  let bestScore = -1;
  let bestI = -1;
  let ties = 0;

  for (const i of order) {
    if (i < 0 || i > n - m) continue;
    const window = contentLines.slice(i, i + m).join("\n");
    const score = normalizedSimilarity(window, normNeedle);
    if (score >= threshold) {
      if (score > bestScore) {
        bestScore = score;
        bestI = i;
        ties = 1;
      } else if (score === bestScore) {
        ties++;
      }
    }
  }

  if (bestI === -1 || ties > 1) return null;
  return computeLineOffsets(contentLines, bestI, m);
}

export function findClosestCandidate(
  content: string,
  oldText: string,
): { similarity: number; candidate: string; line: number; context: string } {
  const needle = stripBoundaryNewlines(oldText);
  const needleLines = needle.split("\n");
  const contentLines = content.split("\n");
  const m = Math.max(1, needleLines.length);
  const n = contentLines.length;

  let bestScore = 0;
  let bestI = 0;
  let bestWindow = "";

  if (n >= m) {
    for (let i = 0; i <= n - m; i++) {
      const window = contentLines.slice(i, i + m).join("\n");
      const score = normalizedSimilarity(window, needle);
      if (score > bestScore) {
        bestScore = score;
        bestI = i;
        bestWindow = window;
      }
    }
  } else {
    bestWindow = contentLines.join("\n");
    bestScore = normalizedSimilarity(bestWindow, needle);
  }

  return {
    similarity: bestScore,
    candidate: bestWindow,
    line: bestI + 1,
    context: surroundingContext(contentLines, bestI, m),
  };
}

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

export function findMatch(
  content: string,
  oldText: string,
  options: FindMatchOptions = {},
): MatchResult {
  const parsed = parseStartLineHint(oldText);
  const text = parsed.text;
  const startLine = options.startLine ?? parsed.startLine;
  const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const tried: string[] = [];

  if (startLine !== undefined) {
    tried.push("line-anchor match");
    const anchored = anchorMatch(content, text, startLine);
    if (anchored) return anchored;
  }

  for (const { name, fn } of MATCHERS) {
    tried.push(name);
    const result = fn(content, text);
    if (result) return result;
  }

  tried.push("middle-out fuzzy match");
  const fuzzy = middleOutFuzzyMatch(content, text, threshold);
  if (fuzzy) return fuzzy;

  const closest = findClosestCandidate(content, text);
  throw new EditMismatchError({
    oldText: text,
    similarity: closest.similarity,
    closestCandidate: closest.candidate,
    closestLine: closest.line,
    context: closest.context,
    triedMatchers: tried,
  });
}
