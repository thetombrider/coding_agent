import type { ScrollBoxRenderable } from "@opentui/core";
import { describe, expect, it } from "vitest";
import { stopToolOutputScrollBubble } from "./expandable.js";

// Minimal stand-in for the ScrollBox geometry the helper reads. A 5-row
// viewport over 20 rows of content can scroll between scrollTop 0 and 15.
function fakeScrollBox(scrollTop: number): ScrollBoxRenderable {
  return {
    scrollTop,
    scrollHeight: 20,
    viewport: { height: 5 },
  } as unknown as ScrollBoxRenderable;
}

function scrollEvent(direction: "up" | "down" | "left" | "right") {
  let stopped = false;
  return {
    event: {
      scroll: { direction },
      stopPropagation: () => {
        stopped = true;
      },
    },
    get stopped() {
      return stopped;
    },
  };
}

describe("stopToolOutputScrollBubble", () => {
  it("stops bubbling while the block can still scroll down", () => {
    const e = scrollEvent("down");
    stopToolOutputScrollBubble(fakeScrollBox(0), e.event);
    expect(e.stopped).toBe(true);
  });

  it("stops bubbling while the block can still scroll up", () => {
    const e = scrollEvent("up");
    stopToolOutputScrollBubble(fakeScrollBox(15), e.event);
    expect(e.stopped).toBe(true);
  });

  it("lets the event bubble (chain to the outer view) at the bottom edge", () => {
    const e = scrollEvent("down");
    stopToolOutputScrollBubble(fakeScrollBox(15), e.event);
    expect(e.stopped).toBe(false);
  });

  it("lets the event bubble at the top edge", () => {
    const e = scrollEvent("up");
    stopToolOutputScrollBubble(fakeScrollBox(0), e.event);
    expect(e.stopped).toBe(false);
  });

  it("ignores horizontal wheel events", () => {
    const e = scrollEvent("left");
    stopToolOutputScrollBubble(fakeScrollBox(5), e.event);
    expect(e.stopped).toBe(false);
  });

  it("does nothing when there is no scrollbox", () => {
    const e = scrollEvent("down");
    expect(() => stopToolOutputScrollBubble(undefined, e.event)).not.toThrow();
    expect(e.stopped).toBe(false);
  });
});
