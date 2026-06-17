import { describe, expect, it } from "vitest";
import { isCopyAllShortcut, isCopyBlockShortcut, isPasteShortcut } from "./shortcuts.js";

const key = (name: string, mods: Partial<{ ctrl: boolean; meta: boolean; shift: boolean }> = {}) => ({
  name,
  ctrl: mods.ctrl ?? false,
  meta: mods.meta ?? false,
  shift: mods.shift ?? false,
});

describe("shortcuts", () => {
  it("detects copy-block shortcuts", () => {
    expect(isCopyBlockShortcut(key("c", { ctrl: true, shift: true }))).toBe(true);
    expect(isCopyBlockShortcut(key("c", { meta: true }))).toBe(true);
    expect(isCopyBlockShortcut(key("o", { ctrl: true }))).toBe(true);
    expect(isCopyBlockShortcut(key("c", { meta: true, shift: true }))).toBe(false);
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
});
