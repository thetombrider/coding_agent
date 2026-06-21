import type { ScrollBoxRenderable } from "@opentui/core";
import { Show } from "solid-js";

export interface ScrollRailLayout {
  track: number;
  thumbHeight: number;
  offset: number;
}

/** Map a ScrollBox to a single solid thumb on a 1-column track. */
export function scrollRailMetrics(scrollRef: ScrollBoxRenderable | undefined): ScrollRailLayout | null {
  if (!scrollRef) return null;
  const track = scrollRef.viewport.height;
  const content = scrollRef.scrollHeight;
  if (track <= 0 || content <= track) return null;

  const scrollRange = content - track;
  const thumbHeight = Math.max(1, Math.round((track / content) * track));
  const travel = Math.max(0, track - thumbHeight);
  const offset = travel === 0 ? 0 : Math.round((scrollRef.scrollTop / scrollRange) * travel);

  return { track, thumbHeight, offset };
}

export function ScrollRail(props: {
  scrollRef: () => ScrollBoxRenderable | undefined;
  trackColor: string;
  thumbColor: string;
  /** Re-read scroll position/size when this value changes. */
  revision: number;
}) {
  const layout = () => {
    props.revision;
    return scrollRailMetrics(props.scrollRef());
  };

  return (
    <Show when={layout()}>
      {(m) => (
        // No explicit height: stretch to the flex row instead. Pinning the box to
        // a fixed `m().track` (read on a lagging revision) let the rail overflow
        // downward over the approval bar when the scroll row shrank. The thumb
        // proportions still come from the metrics; the trailing flexGrow remainder
        // absorbs any slack.
        <box
          flexShrink={0}
          width={1}
          flexDirection="column"
          backgroundColor={props.trackColor}
        >
          <box height={m().offset} flexShrink={0} backgroundColor={props.trackColor} />
          <box height={m().thumbHeight} flexShrink={0} backgroundColor={props.thumbColor} />
          <box flexGrow={1} backgroundColor={props.trackColor} />
        </box>
      )}
    </Show>
  );
}
