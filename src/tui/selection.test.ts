import { describe, expect, it } from "vitest";
import { readRendererSelection } from "./selection.js";

describe("readRendererSelection", () => {
  it("returns null when there is no active selection", () => {
    const renderer = {
      hasSelection: false,
      getSelection: () => null,
    };
    expect(readRendererSelection(renderer)).toBeNull();
  });

  it("returns null when selected text is only whitespace", () => {
    const renderer = {
      hasSelection: true,
      getSelection: () => ({ getSelectedText: () => "   \n" }),
    };
    expect(readRendererSelection(renderer)).toBeNull();
  });

  it("returns selected text when present", () => {
    const renderer = {
      hasSelection: true,
      getSelection: () => ({ getSelectedText: () => "selected lines" }),
    };
    expect(readRendererSelection(renderer)).toBe("selected lines");
  });
});
