import { describe, expect, it } from "vitest";
import {
  buildOsc52Sequence,
  copyToClipboard,
  encodeOsc52Payload,
  formatCopyStatus,
  formatPasteStatus,
  isWsl,
  readFromClipboard,
  resolveCopyCommands,
  resolvePasteCommand,
  shouldTryOsc52First,
  type SpawnFn,
} from "./clipboard.js";

describe("clipboard", () => {
  it("base64-encodes OSC 52 payloads", () => {
    expect(encodeOsc52Payload("hello")).toBe("aGVsbG8=");
    expect(buildOsc52Sequence("hello")).toBe("\x1b]52;c;aGVsbG8=\x07");
  });

  it("resolves platform copy commands in fallback order", () => {
    expect(resolveCopyCommands("darwin", {})).toEqual([{ bin: "pbcopy", args: [] }]);
    expect(resolveCopyCommands("linux", { WSL_DISTRO_NAME: "Ubuntu" })).toEqual([
      { bin: "clip.exe", args: [] },
      { bin: "xclip", args: ["-selection", "clipboard"] },
    ]);
    expect(resolveCopyCommands("linux", { WAYLAND_DISPLAY: "1" })).toEqual([
      { bin: "wl-copy", args: [] },
      { bin: "xclip", args: ["-selection", "clipboard"] },
    ]);
    expect(resolveCopyCommands("linux", {})).toEqual([
      { bin: "xclip", args: ["-selection", "clipboard"] },
    ]);
  });

  it("detects WSL environments", () => {
    expect(isWsl({ WSL_DISTRO_NAME: "Ubuntu" })).toBe(true);
    expect(isWsl({})).toBe(false);
  });

  it("resolves platform paste commands", () => {
    expect(resolvePasteCommand("darwin", {})).toEqual({ bin: "pbpaste", args: [] });
    expect(resolvePasteCommand("linux", { WAYLAND_DISPLAY: "1" })).toEqual({
      bin: "wl-paste",
      args: ["-n"],
    });
    expect(resolvePasteCommand("linux", {})).toEqual({
      bin: "xclip",
      args: ["-selection", "clipboard", "-o"],
    });
  });

  it("writes OSC 52 on Linux TTY after native helpers fail", async () => {
    let written = "";
    const result = await copyToClipboard("line one\nline two", {
      platform: "linux",
      env: {},
      isTty: true,
      writeStdout: (data) => {
        written = data;
      },
      spawn: () =>
        ({
          stdin: { write() {}, end() {} },
          exited: Promise.resolve(1),
        }) as unknown as ReturnType<SpawnFn>,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("osc52");
    expect(result.lineCount).toBe(2);
    expect(written).toBe(buildOsc52Sequence("line one\nline two"));
  });

  it("uses pbcopy on macOS instead of OSC 52", async () => {
    let written = "";
    const result = await copyToClipboard("mac payload", {
      platform: "darwin",
      isTty: true,
      writeStdout: (data) => {
        written = data;
      },
      spawn: () =>
        ({
          stdin: { write() {}, end() {} },
          exited: Promise.resolve(0),
        }) as unknown as ReturnType<SpawnFn>,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("pbcopy");
    expect(written).toBe("");
    expect(shouldTryOsc52First("darwin")).toBe(false);
  });

  it("uses renderer OSC 52 copy when platform helpers fail", async () => {
    let copied = "";
    const result = await copyToClipboard("remote payload", {
      skipOsc52: false,
      platform: "darwin",
      spawn: () => {
        throw new Error("no pbcopy");
      },
      osc52Copy: (text) => {
        copied = text;
        return true;
      },
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("osc52");
    expect(copied).toBe("remote payload");
  });

  it("falls back to platform copy when OSC 52 is skipped", async () => {
    const result = await copyToClipboard("payload", {
      skipOsc52: true,
      platform: "darwin",
      spawn: () =>
        ({
          stdin: { write() {}, end() {} },
          exited: Promise.resolve(0),
        }) as unknown as ReturnType<SpawnFn>,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("pbcopy");
  });

  it("tries the next Linux copy command when wl-copy fails", async () => {
    const attempted: string[] = [];
    const result = await copyToClipboard("payload", {
      skipOsc52: true,
      platform: "linux",
      env: { WAYLAND_DISPLAY: "1" },
      spawn: (command) => {
        attempted.push(command[0]!);
        const ok = command[0] === "xclip";
        return {
          stdin: { write() {}, end() {} },
          exited: Promise.resolve(ok ? 0 : 1),
        } as unknown as ReturnType<SpawnFn>;
      },
    });
    expect(attempted).toEqual(["wl-copy", "xclip"]);
    expect(result.ok).toBe(true);
    expect(result.method).toBe("xclip");
  });

  it("falls back to a temp file when clipboard helpers fail", async () => {
    const result = await copyToClipboard("saved locally", {
      skipOsc52: true,
      platform: "linux",
      env: {},
      spawn: () => {
        throw new Error("no xclip");
      },
      writeTempFile: (text) => `/tmp/orin-clip-test-${text.length}.txt`,
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("file");
    expect(result.path).toBe("/tmp/orin-clip-test-13.txt");
    expect(formatCopyStatus(result)).toContain("Copied to /tmp/orin-clip-test-13.txt");
  });

  it("reports failure when there is nothing to copy", async () => {
    const result = await copyToClipboard("", { isTty: true, writeStdout: () => {} });
    expect(result.ok).toBe(false);
    expect(formatCopyStatus(result)).toContain("Clipboard unavailable");
  });

  it("reads clipboard text via platform helper", async () => {
    const result = await readFromClipboard({
      platform: "darwin",
      readText: async () => "hello clipboard",
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("pbpaste");
    expect(result.text).toBe("hello clipboard");
  });

  it("formats paste failures", () => {
    expect(formatPasteStatus({ ok: false, error: "clipboard is empty" }, 0)).toBe(
      "clipboard is empty",
    );
    expect(formatPasteStatus({ ok: true, text: "hi" }, 2)).toBe("Pasted from clipboard (2 chars)");
  });
});
