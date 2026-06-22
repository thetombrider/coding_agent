import { describe, expect, it } from "vitest";
import {
  applyTerminalEnvOverrides,
  blocksNativeCopyShortcut,
  consumeTerminalCapabilityLeak,
  containsTerminalCapabilityLeak,
  sanitizePromptInput,
  selectionCopyHint,
  terminalStartupCopyHint,
} from "./terminal-env.js";

// The exact garbage Terminal.app paints from OpenTUI's APC-wrapped probe.
const LEAK = "Gi=31337,s=1,v=1,a=q,t=d,f=24;AAAA";

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

describe("terminal capability leak handling", () => {
  it("detects the leaked Kitty graphics probe", () => {
    expect(containsTerminalCapabilityLeak(LEAK)).toBe(true);
    // With the APC framing partially preserved.
    expect(containsTerminalCapabilityLeak(`\x1b_${LEAK}\x1b\\`)).toBe(true);
    // Different id / payload still matches.
    expect(containsTerminalCapabilityLeak("Gi=1,a=q,t=d,f=24;Zm9v")).toBe(true);
  });

  it("does not flag ordinary input", () => {
    expect(containsTerminalCapabilityLeak("")).toBe(false);
    expect(containsTerminalCapabilityLeak("hello world")).toBe(false);
    expect(containsTerminalCapabilityLeak("git status")).toBe(false);
    // A real graphics transmission (a=T, not a=q) must not be stripped.
    expect(containsTerminalCapabilityLeak("Gi=1,a=T,f=24;AAAA")).toBe(false);
  });

  it("strips the leak from prompt input but preserves real text around it", () => {
    expect(sanitizePromptInput(LEAK)).toBe("");
    // Leading text is preserved; the probe is delimited by a space or the APC ST.
    expect(sanitizePromptInput(`hi ${LEAK}`)).toBe("hi ");
    expect(sanitizePromptInput(`${LEAK} fix the bug`)).toBe(" fix the bug");
    expect(sanitizePromptInput(`\x1b_${LEAK}\x1b\\fix the bug`)).toBe("fix the bug");
    // Two APC-framed leaks in one value (the ST delimits them).
    expect(sanitizePromptInput(`\x1b_${LEAK}\x1b\\\x1b_${LEAK}\x1b\\`)).toBe("");
  });

  it("leaves ordinary input untouched (and identity-stable)", () => {
    const normal = "summarize the diff please";
    expect(sanitizePromptInput(normal)).toBe(normal);
    expect(sanitizePromptInput("")).toBe("");
  });

  it("consumes a stdin chunk that is purely the leak, not one carrying keystrokes", () => {
    expect(consumeTerminalCapabilityLeak(LEAK)).toBe(true);
    expect(consumeTerminalCapabilityLeak(`\x1b_${LEAK}\x1b\\`)).toBe(true);
    // A trailing real keystroke (control char / space) must keep the chunk.
    expect(consumeTerminalCapabilityLeak(`${LEAK}\r`)).toBe(false);
    expect(consumeTerminalCapabilityLeak(`${LEAK} hi`)).toBe(false);
    expect(consumeTerminalCapabilityLeak("hello")).toBe(false);
    expect(consumeTerminalCapabilityLeak("")).toBe(false);
  });
});
