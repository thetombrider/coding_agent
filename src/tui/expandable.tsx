import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect, createSignal, For, Show } from "solid-js";
import { ScrollRail } from "./scroll-rail.js";
import { hiddenNativeScrollbar, scrollbars, surfaceSelection, theme } from "./theme.js";
import { formatToolOutputForDisplay, MAX_EXPANDED_VIEW_ROWS } from "./tool-output.js";

function stopToolOutputScrollBubble(
  scrollRef: ScrollBoxRenderable | undefined,
  event: { scroll?: { direction?: string }; stopPropagation: () => void },
) {
  if (!scrollRef) return;
  const dir = event.scroll?.direction;
  if (dir !== "up" && dir !== "down") return;
  const maxScroll = Math.max(0, scrollRef.scrollHeight - scrollRef.viewport.height);
  const canScroll = dir === "up" ? scrollRef.scrollTop > 0 : scrollRef.scrollTop < maxScroll;
  if (canScroll) event.stopPropagation();
}

export function ToolOutputView(props: { output: string; fg?: string }) {
  const formatted = () => formatToolOutputForDisplay(props.output);
  const fg = () => props.fg ?? theme.codeFg;
  const textSelection = () => surfaceSelection(theme.toolOutputBg, fg());
  // Rendered rows = the visible lines plus the optional "more lines" notice.
  const rowCount = () => formatted().lines.length + (formatted().truncated ? 1 : 0);
  const scrollable = () => rowCount() > MAX_EXPANDED_VIEW_ROWS;

  let toolScrollRef: ScrollBoxRenderable | undefined;
  const [scrollRailRevision, setScrollRailRevision] = createSignal(0);
  const bumpScrollRail = () => setScrollRailRevision((n) => n + 1);

  createEffect(() => {
    props.output;
    queueMicrotask(bumpScrollRail);
  });

  const Lines = () => (
    <>
      <For each={formatted().lines}>
        {(line) => (
          <text selectable {...textSelection()} fg={fg()} wrapMode="none">
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
        <box
          flexDirection="column"
          marginLeft={2}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={theme.toolOutputBg}
        >
          <Lines />
        </box>
      }
    >
      <box flexDirection="row" marginLeft={2} height={MAX_EXPANDED_VIEW_ROWS}>
        <scrollbox
          ref={toolScrollRef}
          flexGrow={1}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={theme.toolOutputBg}
          height={MAX_EXPANDED_VIEW_ROWS}
          scrollY
          contentOptions={{ flexDirection: "column" }}
          {...hiddenNativeScrollbar}
          on:scroll={(event) => {
            stopToolOutputScrollBubble(toolScrollRef, event);
            bumpScrollRail();
          }}
        >
          <Lines />
        </scrollbox>
        <ScrollRail
          scrollRef={() => toolScrollRef}
          revision={scrollRailRevision()}
          trackColor={scrollbars.toolOutput.track}
          thumbColor={scrollbars.toolOutput.thumb}
        />
      </box>
    </Show>
  );
}

export function ReasoningOutputView(props: { text: string }) {
  return <ToolOutputView output={props.text} fg={theme.reasoning} />;
}
