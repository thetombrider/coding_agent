import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_VISIBILITY,
  hideAllSidebars,
  showAllSidebars,
  sidebarVisibilityHint,
  toggleSidebar,
} from "./sidebar-state.js";

describe("toggleSidebar", () => {
  it("toggles the left sidebar", () => {
    expect(toggleSidebar(DEFAULT_SIDEBAR_VISIBILITY, "left")).toEqual({
      left: false,
      right: true,
    });
    expect(toggleSidebar({ left: false, right: true }, "left")).toEqual({
      left: true,
      right: true,
    });
  });

  it("toggles the right sidebar", () => {
    expect(toggleSidebar(DEFAULT_SIDEBAR_VISIBILITY, "right")).toEqual({
      left: true,
      right: false,
    });
  });

  it("toggles both sidebars together", () => {
    expect(toggleSidebar(DEFAULT_SIDEBAR_VISIBILITY, "all")).toEqual({
      left: false,
      right: false,
    });
    expect(toggleSidebar({ left: false, right: false }, "all")).toEqual({
      left: true,
      right: true,
    });
  });
});

describe("sidebar visibility helpers", () => {
  it("shows and hides all panels", () => {
    expect(showAllSidebars()).toEqual({ left: true, right: true });
    expect(hideAllSidebars()).toEqual({ left: false, right: false });
  });

  it("formats a status hint", () => {
    expect(sidebarVisibilityHint(DEFAULT_SIDEBAR_VISIBILITY)).toBe(
      "panels: sessions on · info on",
    );
    expect(sidebarVisibilityHint({ left: false, right: true })).toBe(
      "panels: sessions off · info on",
    );
  });
});
