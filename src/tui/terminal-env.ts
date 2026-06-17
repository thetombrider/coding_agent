/** macOS Terminal.app handles ⌘C itself and never sends it to raw TUIs. */
export function blocksNativeCopyShortcut(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TERM_PROGRAM === "Apple_Terminal";
}

export function selectionCopyHint(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "darwin" && blocksNativeCopyShortcut(env)) {
    return "Drag to select, then press c to copy. Option+drag lets Terminal's ⌘C work.";
  }
  if (process.platform === "darwin") {
    return "Drag to select text, then ⌘C to copy.";
  }
  return "Drag to select text, then Ctrl+Shift+C to copy.";
}

export function terminalStartupCopyHint(env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform === "darwin" && blocksNativeCopyShortcut(env)) {
    return "Terminal.app intercepts ⌘C — drag to select, then press c to copy";
  }
  return null;
}
