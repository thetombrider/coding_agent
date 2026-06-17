import { describe, expect, it } from "vitest";
import {
  countOutputLines,
  formatToolOutputForDisplay,
  MAX_OUTPUT_DISPLAY_LINES,
  outputExpandHint,
} from "./tool-output.js";

describe("tool-output", () => {
  it("counts lines without a trailing blank line", () => {
    expect(countOutputLines("a\nb\n")).toBe(2);
    expect(countOutputLines("single")).toBe(1);
  });

  it("formats short output without truncation", () => {
    const result = formatToolOutputForDisplay("line one\nline two");
    expect(result.lines).toEqual(["line one", "line two"]);
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(2);
  });

  it("truncates very large output with guidance", () => {
    const output = Array.from({ length: MAX_OUTPUT_DISPLAY_LINES + 50 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = formatToolOutputForDisplay(output);
    expect(result.lines).toHaveLength(MAX_OUTPUT_DISPLAY_LINES);
    expect(result.truncated).toBe(true);
    expect(result.omittedLines).toBe(50);
    expect(result.totalLines).toBe(MAX_OUTPUT_DISPLAY_LINES + 50);
  });

  it("builds expand hints for single- and multi-line output", () => {
    expect(outputExpandHint("hello")).toBe("▸ expand");
    expect(outputExpandHint("a\nb\nc")).toBe("▸ 3 lines");
  });
});

describe("createToolExpandState", () => {
  it("toggles hovered tool and falls back to the last registered tool", async () => {
    const { createToolExpandState } = await import("./tool-expand.js");
    const expand = createToolExpandState();
    let first = 0;
    let second = 0;
    expand.registerToggle("a", () => { first += 1; });
    expand.registerToggle("b", () => { second += 1; });

    expand.setHovered("a");
    expand.toggleHovered();
    expect(first).toBe(1);
    expect(second).toBe(0);

    expand.setHovered("b");
    expand.toggleHovered();
    expect(second).toBe(1);

    expand.registerToggle("a", null);
    expand.registerToggle("b", null);
    expand.setHovered("missing");
    let fallback = 0;
    expand.registerToggle("c", () => { fallback += 1; });
    expand.toggleHovered();
    expect(fallback).toBe(1);
  });
});
