import { createTextAttributes } from "@opentui/core";
import { For } from "solid-js";
import { theme } from "./theme.js";

const BOLD = createTextAttributes({ bold: true });

function diffColor(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return theme.diffMeta;
  if (line.startsWith("@@")) return theme.muted;
  if (line.startsWith("+")) return theme.diffAdd;
  if (line.startsWith("-")) return theme.diffDel;
  return theme.diffContext;
}

export function DiffView(props: { patch: string }) {
  const lines = () =>
    props.patch.split("\n").filter((line, i, arr) => {
      if (i === arr.length - 1 && line === "") return false;
      return true;
    });

  return (
    <box flexDirection="column" marginLeft={2} paddingLeft={1} paddingRight={1} backgroundColor={theme.codeBg}>
      <For each={lines()}>
        {(line) => (
          <text
            selectable
            fg={diffColor(line)}
            attributes={line.startsWith("+") || line.startsWith("-") ? BOLD : 0}
          >
            {line || " "}
          </text>
        )}
      </For>
    </box>
  );
}
