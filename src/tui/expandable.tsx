import { For, Show } from "solid-js";
import { theme } from "./theme.js";
import { formatToolOutputForDisplay } from "./tool-output.js";

export function ToolOutputView(props: { output: string; fg?: string }) {
  const formatted = () => formatToolOutputForDisplay(props.output);
  const fg = () => props.fg ?? theme.codeFg;

  return (
    <box flexDirection="column" marginLeft={2} paddingLeft={1} paddingRight={1} backgroundColor={theme.codeBg}>
      <For each={formatted().lines}>
        {(line) => (
          <text fg={fg()} wrapMode="none">
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

export function ReasoningOutputView(props: { text: string }) {
  return <ToolOutputView output={props.text} fg={theme.reasoning} />;
}
