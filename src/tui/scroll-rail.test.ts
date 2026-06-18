import { describe, expect, it } from "vitest";
import { scrollRailMetrics } from "./scroll-rail.js";

describe("scrollRailMetrics", () => {
  it("returns null when content fits the viewport", () => {
    expect(scrollRailMetrics({
      viewport: { height: 20 },
      scrollHeight: 20,
      scrollTop: 0,
    } as never)).toBeNull();
  });

  it("returns one solid thumb sized to the viewport/content ratio", () => {
    const layout = scrollRailMetrics({
      viewport: { height: 10 },
      scrollHeight: 100,
      scrollTop: 40,
    } as never);

    expect(layout).toEqual({
      track: 10,
      thumbHeight: 1,
      offset: 4,
    });
  });
});
