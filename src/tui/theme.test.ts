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
  });
});

describe("scrollbars", () => {
  it("uses different track colors for main and tool output scroll areas", () => {
    expect(scrollbars.main.verticalScrollbarOptions.trackOptions.backgroundColor).not.toBe(
      scrollbars.toolOutput.verticalScrollbarOptions.trackOptions.backgroundColor,
    );
  });
});
