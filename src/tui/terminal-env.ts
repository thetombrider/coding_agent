/** macOS Terminal.app handles ⌘C itself and never sends it to raw TUIs. */
export function blocksNativeCopyShortcut(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TERM_PROGRAM === "Apple_Terminal";
}

/**
 * OpenTUI probes Kitty graphics on startup. Terminal.app does not support it and
 * echoes the probe response (e.g. `Gi=31337,s=1,v=1,a=q,t=d,f=24;AAAA`) into the
 * prompt. Disable the probe unless the user already set OPENTUI_GRAPHICS.
 */
export function applyTerminalEnvOverrides(env: NodeJS.ProcessEnv = process.env): void {
  if (env.TERM_PROGRAM === "Apple_Terminal" && env.OPENTUI_GRAPHICS === undefined) {
    env.OPENTUI_GRAPHICS = "0";
  }
}

export function selectionCopyHint(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "darwin" && blocksNativeCopyShortcut(env)) {
    return "Drag to select, then press c to copy. Option+drag lets Terminal's ⌘C work.";
  }
  if (platform === "darwin") {
    return "Drag to select text, then ⌘C to copy.";
  }
  return "Drag to select text, then Ctrl+Shift+C to copy.";
}

export function terminalStartupCopyHint(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === "darwin" && blocksNativeCopyShortcut(env)) {
    return "Terminal.app intercepts ⌘C — drag to select, then press c to copy";
  }
  return null;
}
