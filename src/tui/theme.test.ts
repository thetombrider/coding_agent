import { describe, expect, it } from "vitest";
import { scrollbars, surfaceSelection, theme } from "./theme.js";

describe("surfaceSelection", () => {
  it("inverts foreground and background for legible drag-selection", () => {
    expect(surfaceSelection(theme.bg)).toEqual({
      bg: theme.bg,
      selectionBg: theme.fg,
      selectionFg: theme.bg,
    });
    expect(surfaceSelection(theme.toolOutputBg, theme.reasoning)).toEqual({
      bg: theme.toolOutputBg,
      selectionBg: theme.reasoning,
      selectionFg: theme.toolOutputBg,
    });
    expect(surfaceSelection(theme.bg, theme.reasoning)).toEqual({
      bg: theme.bg,
      selectionBg: theme.reasoning,
      selectionFg: theme.bg,
    });
  });
});

describe("scrollbars", () => {
  it("uses different track colors for main and tool output scroll areas", () => {
    expect(scrollbars.main.track).not.toBe(scrollbars.toolOutput.track);
    expect(scrollbars.main.thumb).not.toBe(scrollbars.toolOutput.thumb);
  });
});
