import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { For } from "solid-js";
import { theme } from "./theme.js";

const LOGO_LINES = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "logo.txt"), "utf8")
  .trim()
  .split("\n");

type Role = "space" | "fill" | "edge";
type Segment = { text: string; fg: string };

const FILL_STOPS = [theme.logoHighlight, theme.logo, theme.logoDeep] as const;

function charRole(ch: string): Role {
  if (ch === " ") return "space";
  if (ch === "█") return "fill";
  return "edge";
}

function fillColor(row: number): string {
  const t = row / Math.max(LOGO_LINES.length - 1, 1);
  const idx = Math.min(FILL_STOPS.length - 1, Math.floor(t * FILL_STOPS.length));
  return FILL_STOPS[idx]!;
}

function colorFor(role: Role, row: number): string {
  switch (role) {
    case "space":
      return theme.bg;
    case "fill":
      return fillColor(row);
    case "edge":
      return theme.logoShadow;
  }
}

function segmentLine(line: string, row: number): Segment[] {
  const segments: Segment[] = [];
  let text = "";
  let role = charRole(line[0] ?? " ");

  for (const ch of line) {
    const nextRole = charRole(ch);
    if (nextRole !== role && text) {
      segments.push({ text, fg: colorFor(role, row) });
      text = "";
      role = nextRole;
    }
    text += ch;
    role = nextRole;
  }
  if (text) segments.push({ text, fg: colorFor(role, row) });
  return segments;
}

export function StartupLogo() {
  return (
    <box flexDirection="column" marginBottom={1}>
      <For each={LOGO_LINES}>
        {(line, row) => (
          <box flexDirection="row">
            <For each={segmentLine(line, row())}>
              {(seg) => <text fg={seg.fg}>{seg.text}</text>}
            </For>
          </box>
        )}
      </For>
    </box>
  );
}
