import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreTerminal } from "./terminal.js";

describe("restoreTerminal", () => {
  let origStdoutTTY: boolean | undefined;
  let origStdinTTY: boolean | undefined;

  beforeEach(() => {
    origStdoutTTY = process.stdout.isTTY;
    origStdinTTY = process.stdin.isTTY;
  });

  afterEach(() => {
    process.stdout.isTTY = origStdoutTTY as boolean;
    process.stdin.isTTY = origStdinTTY as boolean;
    vi.restoreAllMocks();
  });

  it("does nothing when stdout is not a TTY", () => {
    process.stdout.isTTY = false;
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    restoreTerminal();
    expect(write).not.toHaveBeenCalled();
  });

  it("emits the reset sequence (mouse off, alt-screen leave, cursor show) on a TTY", () => {
    process.stdout.isTTY = true;
    process.stdin.isTTY = false;
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    restoreTerminal();

    expect(write).toHaveBeenCalledTimes(1);
    const seq = write.mock.calls[0]![0] as string;
    expect(seq).toContain("\x1b[?1000l"); // mouse tracking off
    expect(seq).toContain("\x1b[?1049l"); // leave alternate screen
    expect(seq).toContain("\x1b[?25h"); // show cursor
  });

  it("never throws when stdout.write fails", () => {
    process.stdout.isTTY = true;
    process.stdin.isTTY = false;
    vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw new Error("EPIPE");
    });

    expect(() => restoreTerminal()).not.toThrow();
  });
});
