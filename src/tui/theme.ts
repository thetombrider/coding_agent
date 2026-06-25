/**
 * Warm editorial base (cream + ink) with cooler panels and a teal accent lane.
 * Role separation:
 * - fg / user / heading — primary reading ink
 * - secondary — tool args, descriptions (readable body)
 * - muted — hints, metadata, footer (receded)
 * - toolDone / border — completed tool chrome (quiet)
 * - reasoning — cool slate for thinking blocks
 * - accent — agent verbs (tools, thinking), inline code, interactive focus
 */
export const theme = {
  bg: "#FFFDF8",
  fg: "#171412",
  /** Hints, footer, expand toggles — lightest ink on the page. */
  muted: "#8A837A",
  /** Tool args, palette descriptions — mid ink, still readable. */
  secondary: "#4A4540",
  /** Selection, prompt caret, focused palette rows. */
  accent: "#1F6866",
  user: "#0F0E0D",
  border: "#C4BAB0",
  codeBg: "#F3EDE4",
  /** Expanded tool / diff panels — cool gray-green off the warm page. */
  toolOutputBg: "#E6ECEA",
  codeFg: "#171412",
  heading: "#0F0E0D",
  diffAdd: "#0F5132",
  diffDel: "#9F1239",
  diffMeta: "#6B6560",
  diffContext: "#2A2724",
  toolRunning: "#B45309",
  /** Completed tool names — recede behind args and hints. */
  toolDone: "#9A9288",
  toolError: "#9F1239",
  approval: "#C05621",
  /** Logo fill gradient — light limestone through deep stone. */
  logoHighlight: "#D4CCC0",
  logo: "#B8AEA0",
  logoDeep: "#9A9288",
  /** Box-drawing edges and extrusion on filled logo glyphs. */
  logoShadow: "#6B6560",
  /** Thinking blocks — cool slate, distinct from warm tool chrome. */
  reasoning: "#5E5A6E",
  /** Subagent nested tool calls under a parent `task`. */
  subagent: "#2E5FA8",
} as const;

export const terminalFg = { r: 23, g: 20, b: 18 } as const;

/** RGB for terminal-wide ANSI background (matches theme.bg). */
export const terminalBg = { r: 255, g: 253, b: 248 } as const;

/** Invert fg/bg for drag-selection so text stays legible on any surface. */
export function surfaceSelection(background: string, foreground: string = theme.fg) {
  return {
    bg: background,
    selectionBg: foreground,
    selectionFg: background,
  } as const;
}

/** Solid scroll-rail colors — main conversation vs nested tool output. */
export const scrollbars = {
  main: {
    track: theme.logoHighlight,
    thumb: theme.logoShadow,
  },
  toolOutput: {
    track: "#D8DFDC",
    thumb: theme.muted,
  },
} as const;

/** Hide OpenTUI's block-character slider; we render a solid rail instead. */
export const hiddenNativeScrollbar = {
  verticalScrollbarOptions: { visible: false },
} as const;
