import { describe, expect, it } from "vitest";
import {
  displayWidth,
  fitColumnWidths,
  normalizeRow,
  parseBlocks,
  parseInline,
  tableChromeWidth,
  wrapInlineParts,
} from "./markdown-parse.js";

describe("parseInline", () => {
  it("parses bold, italic, and code", () => {
    expect(parseInline("**bold** and `code`")).toEqual([
      { kind: "bold", value: "bold" },
      { kind: "text", value: " and " },
      { kind: "code", value: "code" },
    ]);
  });
});

describe("parseBlocks", () => {
  it("parses headings and fenced code", () => {
    const blocks = parseBlocks("## Title\n\n```ts\nconst x = 1\n```");
    expect(blocks[0]).toEqual({ type: "heading", level: 2, text: "Title" });
    expect(blocks[1]).toMatchObject({ type: "code", lang: "ts", body: "const x = 1" });
  });

  it("parses bullet lists", () => {
    const blocks = parseBlocks("- one\n- two");
    expect(blocks[0]).toEqual({
      type: "list",
      ordered: false,
      items: ["one", "two"],
    });
  });

  it("parses markdown tables", () => {
    const source = [
      "| Folder | Purpose |",
      "|--------|---------|",
      "| src/ | Source code |",
      "| dist/ | Compiled `tsc` output |",
    ].join("\n");
    const blocks = parseBlocks(source);
    expect(blocks[0]).toEqual({
      type: "table",
      headers: ["Folder", "Purpose"],
      rows: [
        ["src/", "Source code"],
        ["dist/", "Compiled `tsc` output"],
      ],
    });
  });

  it("parses tables with short (single-dash) separators", () => {
    const source = ["| A | B |", "| - | - |", "| 1 | 2 |"].join("\n");
    const blocks = parseBlocks(source);
    expect(blocks[0]).toMatchObject({ type: "table", headers: ["A", "B"], rows: [["1", "2"]] });
  });
});

describe("displayWidth", () => {
  it("counts ASCII as one column each", () => {
    expect(displayWidth("hello")).toBe(5);
  });

  it("counts emoji and CJK as two columns", () => {
    expect(displayWidth("✅")).toBe(2);
    expect(displayWidth("🔄")).toBe(2);
    expect(displayWidth("⏳")).toBe(2);
    expect(displayWidth("中文")).toBe(4);
    expect(displayWidth("Done ✅")).toBe(7);
  });

  it("ignores zero-width marks and variation selectors", () => {
    expect(displayWidth("é")).toBe(1); // combining acute accent
    expect(displayWidth("a​b")).toBe(2); // zero-width space
    expect(displayWidth("✔️")).toBe(2); // emoji variation selector adds nothing
  });
});

describe("normalizeRow", () => {
  it("pads short rows so columns stay aligned", () => {
    expect(normalizeRow(["a"], 3)).toEqual(["a", "", ""]);
  });

  it("trims overlong rows to the header count", () => {
    expect(normalizeRow(["a", "b", "c", "d"], 2)).toEqual(["a", "b"]);
  });

  it("leaves matching rows untouched", () => {
    expect(normalizeRow(["a", "b"], 2)).toEqual(["a", "b"]);
  });
});

describe("fitColumnWidths", () => {
  it("keeps natural widths when the table already fits", () => {
    expect(fitColumnWidths([5, 5], 100)).toEqual([5, 5]);
  });

  it("shrinks the widest column first, preserving narrow ones", () => {
    // chrome for 2 columns is 7, so total content budget = maxWidth - 7.
    const widths = fitColumnWidths([3, 40], 30);
    expect(widths[0]).toBe(3); // narrow column preserved
    expect(widths[0]! + widths[1]! + tableChromeWidth(2)).toBeLessThanOrEqual(30);
  });

  it("balances reduction across comparably wide columns", () => {
    const widths = fitColumnWidths([20, 20], 27); // budget 20 across two columns
    expect(widths).toEqual([10, 10]);
  });
});

describe("wrapInlineParts", () => {
  it("word-wraps plain text to the given width", () => {
    const lines = wrapInlineParts(parseInline("the quick brown fox"), 9);
    const text = lines.map((line) => line.map((p) => p.value).join(""));
    expect(text).toEqual(["the quick", "brown fox"]);
  });

  it("preserves inline styling across wraps", () => {
    const lines = wrapInlineParts(parseInline("run `tsc` now"), 5);
    expect(lines.length).toBeGreaterThan(1);
    const code = lines.flat().find((p) => p.value === "tsc");
    expect(code?.kind).toBe("code");
  });

  it("hard-breaks a word longer than the column", () => {
    const lines = wrapInlineParts(parseInline("supercalifragilistic"), 6);
    expect(lines.every((line) => displayWidth(line.map((p) => p.value).join("")) <= 6)).toBe(true);
    expect(lines.map((line) => line.map((p) => p.value).join("")).join("")).toBe(
      "supercalifragilistic",
    );
  });

  it("returns a single empty line for empty input", () => {
    expect(wrapInlineParts([], 10)).toEqual([[]]);
  });
});
