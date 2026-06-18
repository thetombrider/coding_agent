import { For, Show } from "solid-js";
import { theme } from "./theme.js";
import { formatToolOutputForDisplay, MAX_EXPANDED_VIEW_ROWS } from "./tool-output.js";

export function ToolOutputView(props: { output: string; fg?: string }) {
  const formatted = () => formatToolOutputForDisplay(props.output);
  const fg = () => props.fg ?? theme.codeFg;
  // Rendered rows = the visible lines plus the optional "more lines" notice.
  const rowCount = () => formatted().lines.length + (formatted().truncated ? 1 : 0);
  const scrollable = () => rowCount() > MAX_EXPANDED_VIEW_ROWS;

  const Lines = () => (
    <>
      <For each={formatted().lines}>
        {(line) => (
          <text selectable fg={fg()} wrapMode="none">
            {line || " "}
          </text>
        )}
      </For>
      <Show when={formatted().truncated}>
        <text selectable={false} fg={theme.secondary}>
          … {formatted().omittedLines} more lines — see session log
        </text>
      </Show>
    </>
  );

  return (
    <Show
      when={scrollable()}
      fallback={
        <box flexDirection="column" marginLeft={2} paddingLeft={1} paddingRight={1} backgroundColor={theme.codeBg}>
          <Lines />
        </box>
      }
    >
      <scrollbox
        marginLeft={2}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.codeBg}
        height={MAX_EXPANDED_VIEW_ROWS}
        scrollY
        contentOptions={{ flexDirection: "column" }}
      >
        <Lines />
      </scrollbox>
    </Show>
  );
}

export function ReasoningOutputView(props: { text: string }) {
  return <ToolOutputView output={props.text} fg={theme.reasoning} />;
}
