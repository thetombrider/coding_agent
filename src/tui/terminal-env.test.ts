import { describe, expect, it } from "vitest";
import {
  blocksNativeCopyShortcut,
  selectionCopyHint,
  terminalStartupCopyHint,
} from "./terminal-env.js";

describe("terminal-env", () => {
  it("detects macOS Terminal.app blocking native copy", () => {
    expect(blocksNativeCopyShortcut({ TERM_PROGRAM: "Apple_Terminal" })).toBe(true);
    expect(blocksNativeCopyShortcut({ TERM_PROGRAM: "vscode" })).toBe(false);
    expect(blocksNativeCopyShortcut({})).toBe(false);
  });

  it("shows Terminal.app-specific copy hints", () => {
    expect(selectionCopyHint({ TERM_PROGRAM: "Apple_Terminal" }, "darwin")).toContain("press c");
    expect(selectionCopyHint({ TERM_PROGRAM: "vscode" }, "darwin")).toContain("⌘C");
    expect(terminalStartupCopyHint({ TERM_PROGRAM: "Apple_Terminal" }, "darwin")).toContain(
      "press c",
    );
    expect(terminalStartupCopyHint({ TERM_PROGRAM: "vscode" }, "darwin")).toBeNull();
  });
});
