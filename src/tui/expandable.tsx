import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect, createMemo, createSignal, Index, Show } from "solid-js";
import { ScrollRail } from "./scroll-rail.js";
import { hiddenNativeScrollbar, scrollbars, surfaceSelection, theme } from "./theme.js";
import { formatToolOutputForDisplay, MAX_EXPANDED_VIEW_ROWS } from "./tool-output.js";

export function stopToolOutputScrollBubble(
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

export function ToolOutputView(props: {
  output: string;
  fg?: string;
  wrapMode?: "none" | "word" | "char";
  backgroundColor?: string;
  scrollbar?: { track: string; thumb: string };
}) {
  const formatted = createMemo(() => formatToolOutputForDisplay(props.output));
  const fg = () => props.fg ?? theme.codeFg;
  const bg = () => props.backgroundColor ?? theme.toolOutputBg;
  const scrollbar = () => props.scrollbar ?? scrollbars.toolOutput;
  // Wrap by default so long bash lines reflow inside the (sidebar-narrowed)
  // column instead of overflowing horizontally over the scroll rail / todo list.
  const wrapMode = () => props.wrapMode ?? "word";
  const textSelection = () => surfaceSelection(bg(), fg());
  // Rendered rows = the visible lines plus the optional "more lines" notice.
  const rowCount = () => { const f = formatted(); return f.lines.length + (f.truncated ? 1 : 0); };
  const scrollable = () => rowCount() > MAX_EXPANDED_VIEW_ROWS;

  let toolScrollRef: ScrollBoxRenderable | undefined;
  const [scrollRailRevision, setScrollRailRevision] = createSignal(0);
  const bumpScrollRail = () => setScrollRailRevision((n) => n + 1);

  createEffect(() => {
    void props.output;
    queueMicrotask(bumpScrollRail);
  });

  const Lines = () => (
    <>
      <Index each={formatted().lines}>
        {(line) => (
          <text
            selectable
            {...textSelection()}
            fg={fg()}
            wrapMode={wrapMode()}
            {...(wrapMode() === "word" ? { flexGrow: 1 } : {})}
          >
            {line() || " "}
          </text>
        )}
      </Index>
      <Show when={formatted().truncated}>
        <text selectable={false} fg={theme.muted}>
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
          backgroundColor={bg()}
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
          backgroundColor={bg()}
          height={MAX_EXPANDED_VIEW_ROWS}
          scrollY
          contentOptions={{ flexDirection: "column" }}
          {...hiddenNativeScrollbar}
          // onMouseScroll (not on:scroll) is the channel ScrollBox actually
          // invokes during a wheel event — and it runs before the box scrolls
          // and bubbles to the parent, so stopPropagation here keeps the outer
          // conversation view from scrolling in lockstep with this block.
          onMouseScroll={(event) => {
            stopToolOutputScrollBubble(toolScrollRef, event);
            bumpScrollRail();
          }}
        >
          <Lines />
        </scrollbox>
        <ScrollRail
          scrollRef={() => toolScrollRef}
          revision={scrollRailRevision()}
          trackColor={scrollbar().track}
          thumbColor={scrollbar().thumb}
        />
      </box>
    </Show>
  );
}

export function ReasoningOutputView(props: { text: string }) {
  // Thinking text sits on the page background — not the cool gray-green tool panel.
  return (
    <ToolOutputView
      output={props.text}
      fg={theme.reasoning}
      wrapMode="word"
      backgroundColor={theme.bg}
      scrollbar={scrollbars.main}
    />
  );
}
