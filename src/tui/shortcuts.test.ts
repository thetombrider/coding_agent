import { describe, expect, it } from "vitest";
import {
  clipboardHintText,
  isCopyAllShortcut,
  isCopyBlockShortcut,
  isPasteShortcut,
  isSelectionCopyShortcut,
  isSelectionHintShortcut,
} from "./shortcuts.js";

const key = (name: string, mods: Partial<{ ctrl: boolean; meta: boolean; shift: boolean }> = {}) => ({
  name,
  ctrl: mods.ctrl ?? false,
  meta: mods.meta ?? false,
  shift: mods.shift ?? false,
});

describe("shortcuts", () => {
  it("detects selection copy shortcuts", () => {
    expect(isSelectionCopyShortcut(key("c", { ctrl: true, shift: true }))).toBe(true);
    expect(isSelectionCopyShortcut(key("c", { meta: true }))).toBe(true);
    expect(isSelectionCopyShortcut(key("c", { meta: true, shift: true }))).toBe(false);
    expect(isSelectionCopyShortcut(key("c"))).toBe(false);
  });

  it("detects copy-block shortcuts", () => {
    expect(isCopyBlockShortcut(key("o", { ctrl: true }))).toBe(true);
    expect(isCopyBlockShortcut(key("c", { meta: true }))).toBe(false);
    expect(isCopyBlockShortcut(key("o", { meta: true }))).toBe(false);
  });

  it("detects copy-all shortcuts", () => {
    expect(isCopyAllShortcut(key("y", { ctrl: true }))).toBe(true);
    expect(isCopyAllShortcut(key("c", { meta: true, shift: true }))).toBe(true);
    expect(isCopyAllShortcut(key("c", { meta: true }))).toBe(false);
  });

  it("detects paste shortcuts", () => {
    expect(isPasteShortcut(key("v", { ctrl: true, shift: true }))).toBe(true);
    expect(isPasteShortcut(key("v", { meta: true }))).toBe(true);
    expect(isPasteShortcut(key("v", { ctrl: true }))).toBe(false);
  });

  it("detects selection hint shortcut", () => {
    expect(isSelectionHintShortcut(key("v"))).toBe(true);
    expect(isSelectionHintShortcut(key("v", { ctrl: true }))).toBe(false);
    expect(isSelectionHintShortcut(key("v", { meta: true }))).toBe(false);
  });

  it("shows Terminal.app-specific clipboard hints", () => {
    expect(clipboardHintText({ TERM_PROGRAM: "Apple_Terminal" })).toContain("select copies on release");
    expect(clipboardHintText({ TERM_PROGRAM: "vscode" })).toContain("⌘C");
  });
});
