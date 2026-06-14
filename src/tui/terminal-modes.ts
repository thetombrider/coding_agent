import { terminalBg, terminalFg } from "./theme.js";

const RESET = "\x1b[0m";
/** Save cursor + switch to alternate buffer (no shell scrollback). */
const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
/** Wheel sends arrow keys while in alternate screen (xterm). */
const ALT_SCROLL_ON = "\x1b[?1007h";
const ALT_SCROLL_OFF = "\x1b[?1007l";

let active = false;

function themePrefix(): string {
  const { r: br, g: bg, b: bb } = terminalBg;
  const { r: fr, g: fg, b: fb } = terminalFg;
  return `\x1b[48;2;${br};${bg};${bb}m\x1b[38;2;${fr};${fg};${fb}m`;
}

/** Enter isolated TUI buffer before Ink draws. Ink alternateScreen stays off to avoid double-switch bugs. */
export function enterTuiTerminal(): void {
  if (!process.stdout.isTTY || active) return;
  process.stdout.write(
    ENTER_ALT_SCREEN
    + HIDE_CURSOR
    + ALT_SCROLL_ON
    + themePrefix()
    + "\x1b[2J\x1b[H",
  );
  active = true;
}

export function exitTuiTerminal(): void {
  if (!process.stdout.isTTY || !active) return;
  process.stdout.write(
    ALT_SCROLL_OFF
    + SHOW_CURSOR
    + EXIT_ALT_SCREEN
    + RESET,
  );
  active = false;
}

export function isTuiTerminalActive(): boolean {
  return active;
}
