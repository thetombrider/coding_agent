import { describe, expect, it } from "vitest";
import { selectedSession, sessionsPaletteAfterDelete, sessionsPaletteHint } from "./sessions-palette.js";

describe("sessionsPaletteHint", () => {
  it("describes delete confirmation controls", () => {
    expect(sessionsPaletteHint("delete")).toContain("Enter delete");
    expect(sessionsPaletteHint("delete")).toContain("Esc cancel");
  });

  it("describes session list navigation including delete", () => {
    expect(sessionsPaletteHint("list")).toContain("→ delete");
    expect(sessionsPaletteHint("list")).toContain("Enter resume");
  });
});

describe("sessionsPaletteAfterDelete", () => {
  it("returns the refreshed list view instead of closing the menu", () => {
    const sessions = [
      { sessionId: "a", cwd: "/", model: "m", createdAt: "t", lastTs: "t", turns: 1 },
    ];
    expect(sessionsPaletteAfterDelete(sessions, 3)).toEqual({
      phase: "sessions",
      index: 0,
      sessions,
      menu: "list",
    });
  });

  it("returns null when no sessions remain", () => {
    expect(sessionsPaletteAfterDelete([], 0)).toBeNull();
  });
});

describe("selectedSession", () => {
  it("returns the session at the current index", () => {
    const sessions = [
      { sessionId: "a", cwd: "/", model: "m", createdAt: "t", lastTs: "t", turns: 1 },
      { sessionId: "b", cwd: "/", model: "m", createdAt: "t", lastTs: "t", turns: 2 },
    ];
    expect(selectedSession({ phase: "sessions", index: 1, sessions, menu: "list" })?.sessionId).toBe("b");
  });
});
