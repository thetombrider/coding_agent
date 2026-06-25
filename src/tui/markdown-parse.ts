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
  | { kind: "code"; value: string }
  | { kind: "math"; value: string };

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
    .every((cell) => /^:?-+:?$/.test(cell.trim()));
}

export function parseTableRow(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

/** Code-point ranges that render two terminal columns wide (CJK + common emoji). */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23fa],
  [0x2600, 0x27bf],
  [0x2b00, 0x2bff],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1faff],
  [0x20000, 0x3fffd],
];

const bunStringWidth = (globalThis as { Bun?: { stringWidth?: (s: string) => number } }).Bun
  ?.stringWidth;

/** Terminal column width of one code point: 0 (control/combining/zero-width), 2 (wide), else 1. */
export function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0; // C0/C1 control
  if (
    (cp >= 0x0300 && cp <= 0x036f) // combining diacritics
    || (cp >= 0x200b && cp <= 0x200f) // zero-width space / joiners / marks
    || (cp >= 0xfe00 && cp <= 0xfe0f) // variation selectors
    || cp === 0xfeff // zero-width no-break space
  ) {
    return 0;
  }
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp < lo) break; // ranges are sorted ascending
    if (cp <= hi) return 2;
  }
  return 1;
}

/**
 * Terminal display width of a string, accounting for wide (CJK/emoji) and
 * zero-width marks. Under Bun (the CLI runtime) this defers to `Bun.stringWidth`,
 * the exact primitive OpenTUI's renderer measures with, so table padding lines up
 * with what's drawn. The code-point fallback covers the Node test runtime.
 */
export function displayWidth(text: string): number {
  if (bunStringWidth) return bunStringWidth(text);
  let width = 0;
  for (const ch of text) width += charWidth(ch.codePointAt(0)!);
  return width;
}

export function plainTextLength(text: string): number {
  return parseInline(text).reduce((sum, part) => sum + displayWidth(part.value), 0);
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

/** Pad or trim a row to exactly `count` cells — models routinely emit ragged rows. */
export function normalizeRow(cells: string[], count: number): string[] {
  if (cells.length === count) return cells;
  if (cells.length > count) return cells.slice(0, count);
  return [...cells, ...Array<string>(count - cells.length).fill("")];
}

/** Fixed per-row chrome: leading "│ ", " │ " between cells, trailing " │". */
export function tableChromeWidth(columns: number): number {
  return 3 * columns + 1;
}

/**
 * Shrink the widest columns until the table fits `maxWidth` terminal columns, so
 * long cells wrap instead of overflowing and breaking the borders. Narrow columns
 * are preserved; if even minimal columns can't fit, returns the soft-floored widths.
 */
export function fitColumnWidths(natural: number[], maxWidth: number, minCol = 3): number[] {
  const widths = [...natural];
  const n = widths.length;
  if (n === 0) return widths;
  const budget = maxWidth - tableChromeWidth(n);
  let total = widths.reduce((sum, w) => sum + w, 0);
  if (total <= budget) return widths;
  const floor = widths.map((w) => Math.min(w, minCol));
  while (total > budget) {
    let idx = -1;
    let widest = 0;
    for (let i = 0; i < n; i++) {
      if (widths[i]! > floor[i]! && widths[i]! > widest) {
        widest = widths[i]!;
        idx = i;
      }
    }
    if (idx === -1) break; // every column is at its floor
    widths[idx] = widths[idx]! - 1;
    total -= 1;
  }
  return widths;
}

function partsWidth(parts: InlinePart[]): number {
  return parts.reduce((sum, part) => sum + displayWidth(part.value), 0);
}

/** Group inline parts into words, splitting on whitespace and dropping the gaps. */
function toWords(parts: InlinePart[]): InlinePart[][] {
  const words: InlinePart[][] = [];
  let current: InlinePart[] = [];
  for (const part of parts) {
    for (const piece of part.value.split(/(\s+)/)) {
      if (piece === "") continue;
      if (/^\s+$/.test(piece)) {
        if (current.length) {
          words.push(current);
          current = [];
        }
      } else {
        current.push({ kind: part.kind, value: piece });
      }
    }
  }
  if (current.length) words.push(current);
  return words;
}

/** Hard-break a single word that is wider than the column into ≤ width chunks. */
function breakWord(word: InlinePart[], width: number): InlinePart[][] {
  const chunks: InlinePart[][] = [];
  let chunk: InlinePart[] = [];
  let chunkWidth = 0;
  for (const part of word) {
    for (const ch of part.value) {
      const cw = displayWidth(ch);
      if (chunkWidth + cw > width && chunk.length) {
        chunks.push(chunk);
        chunk = [];
        chunkWidth = 0;
      }
      const last = chunk[chunk.length - 1];
      if (last && last.kind === part.kind) last.value += ch;
      else chunk.push({ kind: part.kind, value: ch });
      chunkWidth += cw;
    }
  }
  if (chunk.length) chunks.push(chunk);
  return chunks.length ? chunks : [[]];
}

/**
 * Word-wrap inline parts into lines each at most `width` display columns wide,
 * preserving bold/italic/code styling across breaks. A non-positive width
 * disables wrapping (everything on one line).
 */
export function wrapInlineParts(parts: InlinePart[], width: number): InlinePart[][] {
  if (width <= 0) return [parts];
  const lines: InlinePart[][] = [];
  let line: InlinePart[] = [];
  let lineWidth = 0;

  for (const word of toWords(parts)) {
    const wordWidth = partsWidth(word);
    if (wordWidth > width) {
      if (line.length) {
        lines.push(line);
        line = [];
        lineWidth = 0;
      }
      const pieces = breakWord(word, width);
      for (let i = 0; i < pieces.length - 1; i++) lines.push(pieces[i]!);
      line = pieces[pieces.length - 1] ?? [];
      lineWidth = partsWidth(line);
      continue;
    }
    const sep = line.length ? 1 : 0;
    if (line.length && lineWidth + sep + wordWidth > width) {
      lines.push(line);
      line = [];
      lineWidth = 0;
    }
    if (line.length) {
      line.push({ kind: "text", value: " " });
      lineWidth += 1;
    }
    line.push(...word);
    lineWidth += wordWidth;
  }
  if (line.length || lines.length === 0) lines.push(line);
  return lines;
}

const LATEX_TO_UNICODE: Record<string, string> = {
  "\\rightarrow": "→",
  "\\to": "→",
  "\\leftarrow": "←",
  "\\Rightarrow": "⇒",
  "\\Leftarrow": "⇐",
  "\\leftrightarrow": "↔",
  "\\Leftrightarrow": "⇔",
  "\\uparrow": "↑",
  "\\downarrow": "↓",
  "\\alpha": "α",
  "\\beta": "β",
  "\\gamma": "γ",
  "\\delta": "δ",
  "\\epsilon": "ε",
  "\\zeta": "ζ",
  "\\eta": "η",
  "\\theta": "θ",
  "\\iota": "ι",
  "\\kappa": "κ",
  "\\lambda": "λ",
  "\\mu": "μ",
  "\\nu": "ν",
  "\\xi": "ξ",
  "\\pi": "π",
  "\\rho": "ρ",
  "\\sigma": "σ",
  "\\tau": "τ",
  "\\upsilon": "υ",
  "\\phi": "φ",
  "\\chi": "χ",
  "\\psi": "ψ",
  "\\omega": "ω",
  "\\Gamma": "Γ",
  "\\Delta": "Δ",
  "\\Theta": "Θ",
  "\\Lambda": "Λ",
  "\\Xi": "Ξ",
  "\\Pi": "Π",
  "\\Sigma": "Σ",
  "\\Phi": "Φ",
  "\\Psi": "Ψ",
  "\\Omega": "Ω",
  "\\infty": "∞",
  "\\pm": "±",
  "\\times": "×",
  "\\div": "÷",
  "\\cdot": "·",
  "\\leq": "≤",
  "\\geq": "≥",
  "\\neq": "≠",
  "\\approx": "≈",
  "\\equiv": "≡",
  "\\forall": "∀",
  "\\exists": "∃",
  "\\in": "∈",
  "\\notin": "∉",
  "\\subset": "⊂",
  "\\supset": "⊃",
  "\\cup": "∪",
  "\\cap": "∩",
  "\\emptyset": "∅",
  "\\sum": "∑",
  "\\prod": "∏",
  "\\int": "∫",
  "\\partial": "∂",
  "\\nabla": "∇",
  "\\sqrt": "√",
  "\\langle": "⟨",
  "\\rangle": "⟩",
  "\\lfloor": "⌊",
  "\\rfloor": "⌋",
  "\\lceil": "⌈",
  "\\rceil": "⌉",
};

function latexToUnicode(latex: string): string {
  let result = latex;
  const sortedKeys = Object.keys(LATEX_TO_UNICODE).sort((a, b) => b.length - a.length);
  for (const cmd of sortedKeys) {
    result = result.replaceAll(cmd, LATEX_TO_UNICODE[cmd]!);
  }
  result = result.replace(/\^{([^}]+)}/g, (_, exp) => {
    const superscripts: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", "n": "ⁿ", "i": "ⁱ" };
    return [...exp].map(c => superscripts[c] ?? c).join("");
  });
  result = result.replace(/\^(\w)/g, (_, c) => {
    const superscripts: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", "n": "ⁿ", "i": "ⁱ" };
    return superscripts[c] ?? c;
  });
  result = result.replace(/_{([^}]+)}/g, (_, exp) => {
    const subscripts: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎" };
    return [...exp].map(c => subscripts[c] ?? c).join("");
  });
  result = result.replace(/_(\w)/g, (_, c) => {
    const subscripts: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎" };
    return subscripts[c] ?? c;
  });
  result = result.replace(/\\text\{([^}]*)\}/g, "$1");
  result = result.replace(/\\mathrm\{([^}]*)\}/g, "$1");
  result = result.replace(/\\left([(\[|])/g, "$1");
  result = result.replace(/\\right([)\]|])/g, "$1");
  result = result.replace(/\\,/g, " ");
  result = result.replace(/\\;/g, " ");
  result = result.replace(/\\/g, "");
  result = result.replace(/[{}]/g, "");
  return result.trim();
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

    const math = rest.match(/^\$([^$]+)\$/);
    if (math) {
      parts.push({ kind: "math", value: latexToUnicode(math[1]!) });
      rest = rest.slice(math[0].length);
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

    const next = rest.search(/(`|\$|\*\*|__|\*|_)/);
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
