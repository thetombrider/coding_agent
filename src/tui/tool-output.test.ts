import { describe, expect, it } from "vitest";
import {
  countOutputLines,
  EXPAND_HINT_LINE_COUNT_THRESHOLD,
  formatHoverExpandFooter,
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

  it("builds tiered expand hints for collapsed output", () => {
    expect(outputExpandHint("hello")).toBe("");
    expect(outputExpandHint("a\nb")).toBe("▸");
    const tenLines = Array.from({ length: EXPAND_HINT_LINE_COUNT_THRESHOLD }, (_, i) => `line ${i + 1}`).join("\n");
    expect(outputExpandHint(tenLines)).toBe(`▸ ${EXPAND_HINT_LINE_COUNT_THRESHOLD} lines`);
  });

  it("builds hover footer hints for expanded and collapsed blocks", () => {
    expect(formatHoverExpandFooter("grep", "hello", false)).toBe("grep · click to expand");
    expect(formatHoverExpandFooter("grep", "a\nb\nc", false)).toBe("grep · 3 lines · click to expand");
    expect(formatHoverExpandFooter("thinking", "text", true)).toBe("thinking · expanded · c copy");
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

  it("returns hovered and expanded tool output for copy", async () => {
    const { createToolExpandState } = await import("./tool-expand.js");
    const expand = createToolExpandState();
    expand.registerCopyTarget("a", {
      label: "grep",
      getOutput: () => "full output",
      isExpanded: () => true,
    });
    expand.registerCopyTarget("b", {
      label: "read",
      getOutput: () => "collapsed",
      isExpanded: () => false,
    });
    expand.setHovered("a");
    expect(expand.getHoveredOutput()).toBe("full output");
    expect(expand.getHoveredExpandedOutput()).toBe("full output");
    expand.setHovered("b");
    expect(expand.getHoveredOutput()).toBe("collapsed");
    expect(expand.getHoveredExpandedOutput()).toBeUndefined();
  });

  it("keeps separate toggles when the same tool id appears in different turns", async () => {
    const { createToolExpandState } = await import("./tool-expand.js");
    const expand = createToolExpandState();
    let first = 0;
    let second = 0;
    expand.registerToggle("turn-0/call_0", () => { first += 1; });
    expand.registerToggle("turn-1/call_0", () => { second += 1; });

    expand.setHovered("turn-0/call_0");
    expand.toggleHovered();
    expect(first).toBe(1);
    expect(second).toBe(0);

    expand.setHovered("turn-1/call_0");
    expand.toggleHovered();
    expect(first).toBe(1);
    expect(second).toBe(1);
  });

  it("returns contextual footer hints for hovered blocks", async () => {
    const { createToolExpandState } = await import("./tool-expand.js");
    const expand = createToolExpandState();
    expand.registerCopyTarget("a", {
      label: "grep",
      getOutput: () => Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"),
      isExpanded: () => false,
    });

    expect(expand.getHoverFooterHint()).toBeNull();
    expand.setHovered("a");
    expect(expand.getHoverFooterHint()).toBe("grep · 12 lines · click to expand");

    expand.setExpanded("a", true);
    expect(expand.getHoverFooterHint()).toBe("grep · expanded · c copy");
  });
});
