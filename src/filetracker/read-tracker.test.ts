import { describe, expect, it } from "vitest";
import { ReadTracker } from "./read-tracker.js";

describe("ReadTracker", () => {
  it("reports never_read when no record exists", () => {
    const tracker = new ReadTracker();
    expect(tracker.checkStale("/tmp/foo.ts", 100)).toBe("never_read");
  });

  it("reports fresh when mtime matches read time", () => {
    const tracker = new ReadTracker();
    tracker.recordRead("/tmp/foo.ts", 100);
    expect(tracker.checkStale("/tmp/foo.ts", 100)).toBeNull();
  });

  it("reports stale when mtime advanced since read", () => {
    const tracker = new ReadTracker();
    tracker.recordRead("/tmp/foo.ts", 100);
    expect(tracker.checkStale("/tmp/foo.ts", 200)).toBe("stale");
  });

  it("clears staleness after markWritten", () => {
    const tracker = new ReadTracker();
    tracker.recordRead("/tmp/foo.ts", 100);
    tracker.markWritten("/tmp/foo.ts", 200);
    expect(tracker.checkStale("/tmp/foo.ts", 200)).toBeNull();
  });

  it("stores and takes pending warnings", () => {
    const tracker = new ReadTracker();
    tracker.setPendingWarning("/tmp/foo.ts", "warn");
    expect(tracker.takePendingWarning("/tmp/foo.ts")).toBe("warn");
    expect(tracker.takePendingWarning("/tmp/foo.ts")).toBeUndefined();
  });
});
