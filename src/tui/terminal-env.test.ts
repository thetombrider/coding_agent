import { describe, expect, it } from "vitest";
import { blocksNativeCopyShortcut, copyOnSelectionRelease } from "./terminal-env.js";

describe("terminal-env", () => {
  it("detects macOS Terminal.app blocking native copy", () => {
    expect(blocksNativeCopyShortcut({ TERM_PROGRAM: "Apple_Terminal" })).toBe(true);
    expect(blocksNativeCopyShortcut({ TERM_PROGRAM: "vscode" })).toBe(false);
    expect(blocksNativeCopyShortcut({})).toBe(false);
  });

  it("copies on selection release only for Terminal.app", () => {
    expect(copyOnSelectionRelease({ TERM_PROGRAM: "Apple_Terminal" })).toBe(true);
    expect(copyOnSelectionRelease({ TERM_PROGRAM: "iTerm.app" })).toBe(false);
  });
});
