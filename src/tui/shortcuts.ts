import type { KeyEvent } from "@opentui/core";
import { blocksNativeCopyShortcut } from "./terminal-env.js";

type ShortcutKey = Pick<KeyEvent, "name" | "ctrl" | "meta" | "shift">;

/** Standard copy shortcut — copies the current drag selection only. */
export function isSelectionCopyShortcut(key: ShortcutKey): boolean {
  if (key.name !== "c") return false;
  return (key.ctrl && key.shift && !key.meta) || (key.meta && !key.shift);
}

/** Copy the current drag selection with an unmodified `c` key. */
export function isPlainSelectionCopyShortcut(key: ShortcutKey): boolean {
  return key.name === "c" && !key.ctrl && !key.meta && !key.shift;
}

/** Stop a running turn when busy; exit when idle — Ctrl+C only, not Ctrl+Shift+C (copy). */
export function isInterruptShortcut(key: ShortcutKey): boolean {
  return key.name === "c" && key.ctrl && !key.shift && !key.meta;
}

/** Copy the focused conversation block (Ctrl+O). */
export function isCopyBlockShortcut(key: ShortcutKey): boolean {
  return key.name === "o" && key.ctrl && !key.meta && !key.shift;
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

/** Show drag-to-select hint. */
export function isSelectionHintShortcut(key: ShortcutKey): boolean {
  return key.name === "v" && !key.ctrl && !key.meta && !key.shift;
}

export function clipboardHintText(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "darwin" && blocksNativeCopyShortcut(env)) {
    return "select · c copy · ⌘⇧C all · ⌘V paste · Ctrl+O block · click expand";
  }
  if (platform === "darwin") {
    return "select · ⌘C · ⌘⇧C all · ⌘V paste · Ctrl+O block · click expand · c expanded";
  }
  return "select · Ctrl+Shift+C · Ctrl+Y all · Ctrl+Shift+V paste · Ctrl+O block · click expand · c expanded";
}
