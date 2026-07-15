import { describe, expect, it } from "vitest";
import { sessionsSidebarHint } from "./sessions-sidebar.js";

describe("sessionsSidebarHint", () => {
  it("prompts to focus the sidebar when it is visible but not active", () => {
    expect(sessionsSidebarHint("list", false)).toContain("/sessions");
    expect(sessionsSidebarHint("list", false)).toContain("browse");
  });

  it("describes list navigation when focused", () => {
    expect(sessionsSidebarHint("list", true)).toContain("↑↓ navigate");
    expect(sessionsSidebarHint("list", true)).toContain("→ delete");
    expect(sessionsSidebarHint("list", true)).toContain("Enter resume");
    expect(sessionsSidebarHint("list", true)).toContain("Esc unfocus");
  });

  it("describes delete confirmation when focused", () => {
    expect(sessionsSidebarHint("delete", true)).toContain("Enter delete");
    expect(sessionsSidebarHint("delete", true)).toContain("Esc cancel");
  });
});
