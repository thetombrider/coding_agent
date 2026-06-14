import { describe, expect, it } from "vitest";
import type { Turn } from "./controller.js";
import {
  lineCount,
  scrollStartLine,
  totalContentLines,
  visibleContentWindow,
  visibleTurnWindow,
  messageBodyRows,
  maxVisibleTurns,
} from "./scroll.js";

const turn = (user: string, assistant = ""): Turn => ({
  userText: user,
  assistantText: assistant,
  tools: [],
});

describe("visibleTurnWindow", () => {
  const completed = [turn("a"), turn("b"), turn("c")];

  it("shows the latest turns at the bottom by default", () => {
    const { turns, hiddenBefore } = visibleTurnWindow(completed, null, 0, 2);
    expect(turns.map((t) => t.userText)).toEqual(["b", "c"]);
    expect(hiddenBefore).toBe(1);
  });

  it("scrolls up through older turns", () => {
    const { turns, hiddenAfter } = visibleTurnWindow(completed, null, 1, 2);
    expect(turns.map((t) => t.userText)).toEqual(["a", "b"]);
    expect(hiddenAfter).toBe(1);
  });

  it("includes the in-progress turn", () => {
    const { turns } = visibleTurnWindow(completed, turn("live"), 0, 3);
    expect(turns.at(-1)?.userText).toBe("live");
  });
});

describe("visibleContentWindow", () => {
  it("keeps chronological order for a new live turn", () => {
    const completed = [turn("first", "answer one")];
    const live = turn("second", "streaming…");
    const width = 80;
    const viewport = 20;

    const { slices } = visibleContentWindow(completed, live, viewport, width, true, null);
    expect(slices.map((s) => s.turn.userText)).toEqual(["first", "second"]);
    expect(slices[0]?.slice.showUser).toBe(true);
    expect(slices[1]?.slice.showUser).toBe(true);
  });

  it("does not duplicate the current question at the top", () => {
    const completed = [turn("old", "old reply")];
    const live = turn("new", "new reply");
    const { slices } = visibleContentWindow(completed, live, 30, 80, true, null);
    const users = slices.filter((s) => s.slice.showUser).map((s) => s.turn.userText);
    expect(users).toEqual(["old", "new"]);
  });

  it("anchors viewport when not following tail during stream growth", () => {
    const completed = [turn("prior", "prior reply")];
    const shortLive = turn("current", "line one");
    const width = 80;
    const viewport = 8;
    const anchor = visibleContentWindow(completed, shortLive, viewport, width, false, 0);

    const longLive = turn("current", "line one\nline two\nline three\nline four");
    const anchored = visibleContentWindow(completed, longLive, viewport, width, false, 0);

    expect(anchored.viewportStartLine).toBe(anchor.viewportStartLine);
    expect(anchored.slices[0]?.turn.userText).toBe("prior");
  });

  it("follows the bottom while followTail is true", () => {
    const completed = [turn("a", "x".repeat(200))];
    const live = turn("b", "tail");
    const width = 40;
    const viewport = 6;
    const first = visibleContentWindow(completed, live, viewport, width, true, null);
    const longer = visibleContentWindow(
      completed,
      turn("b", "tail\nmore lines"),
      viewport,
      width,
      true,
      null,
    );

    expect(longer.viewportStartLine).toBeGreaterThan(first.viewportStartLine);
    expect(longer.hiddenAfterLines).toBe(0);
  });
});

describe("line helpers", () => {
  it("wraps long lines", () => {
    expect(lineCount("abcdef", 3)).toBe(2);
  });

  it("computes scroll start from anchor", () => {
    expect(scrollStartLine(true, null, 40, 10)).toBe(30);
    expect(scrollStartLine(false, 5, 40, 10)).toBe(5);
    expect(scrollStartLine(false, 100, 40, 10)).toBe(30);
  });

  it("totals content height", () => {
    const turns = [turn("hello", "world")];
    expect(totalContentLines(turns, 80)).toBeGreaterThan(0);
  });
});

describe("layout helpers", () => {
  it("reserves space for header and input", () => {
    expect(messageBodyRows(24)).toBeGreaterThan(6);
    expect(maxVisibleTurns(messageBodyRows(24))).toBeGreaterThanOrEqual(2);
  });
});
