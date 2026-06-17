/** macOS Terminal.app handles ⌘C itself and never sends it to raw TUIs. */
export function blocksNativeCopyShortcut(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TERM_PROGRAM === "Apple_Terminal";
}

export function copyOnSelectionRelease(env: NodeJS.ProcessEnv = process.env): boolean {
  return blocksNativeCopyShortcut(env);
}
