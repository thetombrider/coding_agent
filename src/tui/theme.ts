/** High-contrast warm palette — cream ground, near-black ink. */
export const theme = {
  bg: "#FFFDF8",
  fg: "#171412",
  muted: "#4A4540",
  secondary: "#5C5650",
  accent: "#171412",
  user: "#0F0E0D",
  border: "#B8AEA0",
  codeBg: "#EDE7DB",
  codeFg: "#171412",
  heading: "#0F0E0D",
  diffAdd: "#0F5132",
  diffDel: "#9F1239",
  diffMeta: "#4A4540",
  diffContext: "#171412",
  toolRunning: "#854D0E",
  toolDone: "#4A4540",
  toolError: "#9F1239",
  approval: "#713F12",
} as const;

/** RGB for terminal-wide ANSI foreground (matches theme.fg). */
export const terminalFg = { r: 23, g: 20, b: 18 } as const;

/** RGB for terminal-wide ANSI background (matches theme.bg). */
export const terminalBg = { r: 255, g: 253, b: 248 } as const;
