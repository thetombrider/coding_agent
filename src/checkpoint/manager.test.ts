import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckpointManager, type CheckpointRecord } from "./manager.js";

describe("createCheckpointManager", () => {
  let base: string;
  let work: string;
  let recorded: CheckpointRecord[];
  let isLocal: boolean;
  let sessionId: string;

  const make = () =>
    createCheckpointManager({
      getSessionId: () => sessionId,
      getWorkTree: () => work,
      isLocalWorkspace: () => isLocal,
      record: (rec) => recorded.push(rec),
      gitDirFor: (id) => join(base, "shadow", id),
    });

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "orin-cpm-"));
    work = join(base, "work");
    mkdirSync(work, { recursive: true });
    recorded = [];
    isLocal = true;
    sessionId = "sess1";
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("baselines once and records checkpoints after mutating tools", () => {
    const m = make();
    writeFileSync(join(work, "a.txt"), "v1");
    m.baseline();
    m.baseline(); // idempotent
    expect(recorded.filter((r) => r.tool === "baseline").length).toBe(1);

    writeFileSync(join(work, "a.txt"), "v2");
    const rec = m.afterTool("edit");
    expect(rec).not.toBeNull();
    expect(rec!.tool).toBe("edit");
  });

  it("returns null when a tool changed nothing", () => {
    const m = make();
    m.baseline();
    expect(m.afterTool("bash")).toBeNull();
  });

  it("restore rolls the tree back and snapshots a safety checkpoint first", () => {
    const m = make();
    writeFileSync(join(work, "a.txt"), "original");
    m.baseline();
    const target = recorded[0]!;

    writeFileSync(join(work, "a.txt"), "broken");
    m.afterTool("edit");
    // An uncommitted change after the last checkpoint — restore must snapshot it
    // as a safety checkpoint so it isn't silently lost.
    writeFileSync(join(work, "a.txt"), "uncommitted");

    const res = m.restore(target.id);
    expect(res.ok).toBe(true);
    expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("original");
    // A pre-restore safety checkpoint was recorded so the restore is reversible.
    expect(recorded.some((r) => r.tool === "restore")).toBe(true);
  });

  it("restores the latest checkpoint when no id is given", () => {
    const m = make();
    writeFileSync(join(work, "a.txt"), "one");
    m.baseline();
    writeFileSync(join(work, "a.txt"), "two");
    m.afterTool("edit");

    writeFileSync(join(work, "a.txt"), "uncommitted-mess");
    const res = m.restore();
    expect(res.ok).toBe(true);
    expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("two");
  });

  it("lists checkpoints newest-first", () => {
    const m = make();
    writeFileSync(join(work, "a.txt"), "one");
    m.baseline();
    writeFileSync(join(work, "a.txt"), "two");
    m.afterTool("edit");
    const list = m.list();
    expect(list[0]!.tool).toBe("edit");
    expect(list[list.length - 1]!.tool).toBe("baseline");
  });

  it("is a no-op for non-local workspaces", () => {
    isLocal = false;
    const m = make();
    m.baseline();
    expect(m.afterTool("edit")).toBeNull();
    expect(recorded).toEqual([]);
    expect(m.restore().ok).toBe(false);
    expect(existsSync(join(base, "shadow"))).toBe(false);
  });

  it("is a no-op for non-checkpointable work trees (e.g. home/root)", () => {
    const m = createCheckpointManager({
      getSessionId: () => sessionId,
      getWorkTree: () => work,
      isLocalWorkspace: () => true,
      record: (rec) => recorded.push(rec),
      gitDirFor: (id) => join(base, "shadow", id),
      isCheckpointable: () => false,
    });
    writeFileSync(join(work, "a.txt"), "v1");
    m.baseline();
    expect(m.afterTool("edit")).toBeNull();
    expect(recorded).toEqual([]);
    // restore surfaces a clear reason rather than silently doing nothing.
    const res = m.restore();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/project directory/);
    expect(existsSync(join(base, "shadow"))).toBe(false);
  });

  it("bind seeds a resumed session's checkpoints and marks it baselined", () => {
    const m = make();
    const seeded: CheckpointRecord = { id: "abc123", label: "session baseline", ts: "t", tool: "baseline" };
    m.bind("sess1", [seeded]);
    expect(m.list()).toEqual([seeded]);
    // Already baselined → baseline() does not snapshot again.
    m.baseline();
    expect(recorded).toEqual([]);
  });
});
