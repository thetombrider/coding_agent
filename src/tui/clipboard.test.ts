import { describe, expect, it } from "vitest";
import {
  buildOsc52Sequence,
  copyToClipboard,
  encodeOsc52Payload,
  formatCopyStatus,
  formatPasteStatus,
  readFromClipboard,
  resolveCopyCommand,
  resolvePasteCommand,
  type SpawnFn,
} from "./clipboard.js";

describe("clipboard", () => {
  it("base64-encodes OSC 52 payloads", () => {
    expect(encodeOsc52Payload("hello")).toBe("aGVsbG8=");
    expect(buildOsc52Sequence("hello")).toBe("\x1b]52;c;aGVsbG8=\x07");
  });

  it("resolves platform copy commands", () => {
    expect(resolveCopyCommand("darwin", {})).toEqual({ bin: "pbcopy", args: [] });
    expect(resolveCopyCommand("linux", { WAYLAND_DISPLAY: "1" })).toEqual({
      bin: "wl-copy",
      args: [],
    });
    expect(resolveCopyCommand("linux", {})).toEqual({
      bin: "xclip",
      args: ["-selection", "clipboard"],
    });
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

  it("writes OSC 52 when stdout is a TTY", async () => {
    let written = "";
    const result = await copyToClipboard("line one\nline two", {
      isTty: true,
      writeStdout: (data) => {
        written = data;
      },
    });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("osc52");
    expect(result.lineCount).toBe(2);
    expect(written).toBe(buildOsc52Sequence("line one\nline two"));
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
