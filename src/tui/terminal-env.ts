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
 * OpenTUI enables SGR mouse reporting (modes 1000/1002/1003 + 1006), so every
 * click, drag, or move emits an SGR mouse report: `ESC [ < Cb ; Cx ; Cy (M|m)`.
 * OpenTUI consumes these for selection and hover, but any that reach a prompt
 * field — most visibly while typing or pasting an API key into the provider
 * setup box — render as literal `<35;36;19M` garbage that piles up as the mouse
 * moves (issue #183). We strip them from prompt input exactly like the Kitty
 * probe. The leading ESC is optional because some terminals/inputs drop the
 * control byte and keep only the printable tail.
 */
const MOUSE_SGR_REPORT_SOURCE = String.raw`(?:\x1b)?\[<\d+;\d+;\d+[Mm]`;

/** Global matcher used to strip every mouse report from a string. */
export const MOUSE_SGR_REPORT_RE = new RegExp(MOUSE_SGR_REPORT_SOURCE, "g");

/** True when `text` contains an SGR mouse report. */
export function containsMouseSequence(text: string): boolean {
  if (!text || !text.includes("[<")) return false;
  return new RegExp(MOUSE_SGR_REPORT_SOURCE).test(text);
}

/**
 * Remove terminal noise that leaks into prompt input — the Kitty graphics
 * capability query and SGR mouse reports. Each cheap `includes` guard keeps this
 * a no-op for ordinary keystrokes.
 */
export function sanitizePromptInput(value: string): string {
  if (!value) return value;
  let out = value;
  if (out.includes("a=q")) out = out.replace(KITTY_GRAPHICS_QUERY_LEAK_RE, "");
  if (out.includes("[<")) out = out.replace(MOUSE_SGR_REPORT_RE, "");
  return out;
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

/**
 * Input-handler predicate (for OpenTUI `prependInputHandlers`): returns true to
 * consume a stdin chunk *only* when the chunk is entirely SGR mouse reports
 * (one or more), so we never swallow a chunk that also carries real keystrokes.
 * Mixed chunks fall through to {@link sanitizePromptInput} at the value layer.
 *
 * This is the stdin-layer defense against mouse tracking garbage (#183). Without
 * it, mouse bytes reach the InputRenderable and render as literal `<35;36;19M`
 * text for one frame before {@link sanitizePromptInput} strips them at the value
 * layer — a visible flicker on rapid mouse movement. Catching them here prevents
 * them from ever reaching the input, so no new feature that adds an input path
 * can reintroduce the garbage.
 */
export function consumeMouseReports(sequence: string): boolean {
  if (!sequence || !sequence.includes("[<")) return false;
  return sequence.replace(MOUSE_SGR_REPORT_RE, "").length === 0;
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
