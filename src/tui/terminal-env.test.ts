import { describe, expect, it } from "vitest";
import {
  applyTerminalEnvOverrides,
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

  it("disables OpenTUI Kitty graphics probe on Terminal.app", () => {
    const env: NodeJS.ProcessEnv = { TERM_PROGRAM: "Apple_Terminal" };
    applyTerminalEnvOverrides(env);
    expect(env.OPENTUI_GRAPHICS).toBe("0");

    const preset: NodeJS.ProcessEnv = { TERM_PROGRAM: "Apple_Terminal", OPENTUI_GRAPHICS: "1" };
    applyTerminalEnvOverrides(preset);
    expect(preset.OPENTUI_GRAPHICS).toBe("1");

    const other: NodeJS.ProcessEnv = { TERM_PROGRAM: "iTerm.app" };
    applyTerminalEnvOverrides(other);
    expect(other.OPENTUI_GRAPHICS).toBeUndefined();
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
