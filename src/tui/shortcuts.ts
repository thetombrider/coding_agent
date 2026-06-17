import type { KeyEvent } from "@opentui/core";

type ShortcutKey = Pick<KeyEvent, "name" | "ctrl" | "meta" | "shift">;

/** Copy the focused conversation block. */
export function isCopyBlockShortcut(key: ShortcutKey): boolean {
  if (key.name === "o") return key.ctrl && !key.meta && !key.shift;
  if (key.name !== "c") return false;
  return (key.ctrl && key.shift && !key.meta) || (key.meta && !key.shift);
}

/** Copy the full visible conversation. */
export function isCopyAllShortcut(key: ShortcutKey): boolean {
  if (key.name === "y") return key.ctrl && !key.meta && !key.shift;
  if (key.name === "c") return key.meta && key.shift;
  return false;
}

/** Paste from the system clipboard into the prompt. */
export function isPasteShortcut(key: ShortcutKey): boolean {
  if (key.name !== "v") return false;
  return (key.ctrl && key.shift && !key.meta) || (key.meta && !key.shift);
}

export function clipboardHintText(): string {
  if (process.platform === "darwin") {
    return "⌘C copy · ⌘⇧C copy all · ⌘V paste · o expand · c copy expanded/diff tool";
  }
  return "Ctrl+Shift+C copy · Ctrl+Y all · Ctrl+Shift+V paste · o expand · c copy expanded/diff tool";
}
