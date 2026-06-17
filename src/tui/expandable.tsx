import { For, Show } from "solid-js";
import { theme } from "./theme.js";
import { formatToolOutputForDisplay } from "./tool-output.js";

export function ToolOutputView(props: { output: string }) {
  const formatted = () => formatToolOutputForDisplay(props.output);

  return (
    <box flexDirection="column" marginLeft={2} paddingLeft={1} paddingRight={1} backgroundColor={theme.codeBg}>
      <For each={formatted().lines}>
        {(line) => (
          <text fg={theme.codeFg} wrapMode="none">
            {line || " "}
          </text>
        )}
      </For>
      <Show when={formatted().truncated}>
        <text fg={theme.secondary}>
          … {formatted().omittedLines} more lines — see session log
        </text>
      </Show>
    </box>
  );
}
