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

/**
 * Source pattern for OpenTUI's Kitty graphics *capability query* as Terminal.app
 * renders it. OpenTUI writes the query wrapped in an APC string
 * (`\x1b_Gi=<id>,...,a=q,...;<base64>\x1b\\`). Terminal.app does not understand
 * APC, so it paints the inner bytes — e.g. `Gi=31337,s=1,v=1,a=q,t=d,f=24;AAAA` —
 * as literal text. We key on the `a=q` (query) action so we only ever match the
 * probe, never a real graphics transmission on a graphics-capable terminal.
 */
const KITTY_GRAPHICS_QUERY_LEAK_SOURCE = String.raw`(?:\x1b)?_?Gi=\d+(?:,[a-zA-Z]+=[^,;]+)*,a=q(?:,[a-zA-Z]+=[^,;]+)*;[A-Za-z0-9+/=]*(?:\x1b\\)?`;

/** Global matcher used to strip every occurrence of the leak from a string. */
export const KITTY_GRAPHICS_QUERY_LEAK_RE = new RegExp(KITTY_GRAPHICS_QUERY_LEAK_SOURCE, "g");

/** True when `text` contains OpenTUI's leaked Kitty graphics capability query. */
export function containsTerminalCapabilityLeak(text: string): boolean {
  if (!text || !text.includes("a=q")) return false;
  return new RegExp(KITTY_GRAPHICS_QUERY_LEAK_SOURCE).test(text);
}

/**
 * Remove any leaked Kitty graphics capability query from prompt input. The cheap
 * `includes` guard keeps this a no-op for ordinary keystrokes.
 */
export function sanitizePromptInput(value: string): string {
  if (!value || !value.includes("a=q")) return value;
  return value.replace(KITTY_GRAPHICS_QUERY_LEAK_RE, "");
}

/**
 * Input-handler predicate (for OpenTUI `prependInputHandlers`): returns true to
 * consume a stdin chunk *only* when the chunk is nothing but the leaked probe,
 * so we never swallow a chunk that also carries real keystrokes. Mixed chunks
 * fall through to {@link sanitizePromptInput} at the value layer.
 */
export function consumeTerminalCapabilityLeak(sequence: string): boolean {
  if (!sequence || !sequence.includes("a=q")) return false;
  return sequence.replace(KITTY_GRAPHICS_QUERY_LEAK_RE, "").length === 0;
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
