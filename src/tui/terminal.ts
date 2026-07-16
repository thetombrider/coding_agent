/** Best-effort terminal restore after the TUI exits or crashes. */
export function restoreTerminal(): void {
  if (!process.stdout.isTTY) return;
  const reset =
    "\x1b[?1006l" + // SGR mouse off
    "\x1b[?1002l" + // cell mouse off
    "\x1b[?1003l" + // any-event mouse off
    "\x1b[?1000l" + // mouse tracking off
    "\x1b[?1049l" + // leave alternate screen
    "\x1b[?25h" + // show cursor
    "\x1b[?2031l" + // theme/color-change notification mode off
    "\x1b[0m" + // reset attributes
    "\x1b]111\x07\x1b]110\x07"; // reset default fg/bg
  // Best-effort and must never throw: this runs in `finally` blocks and a
  // process "exit" handler, where a throw would mask the original error.
  try {
    process.stdout.write(reset);
  } catch {
    // ignore (e.g. stdout already closed)
  }
  try {
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      process.stdin.setRawMode(false);
    }
  } catch {
    // ignore
  }
}
