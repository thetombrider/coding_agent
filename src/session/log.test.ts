import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateSessionId,
  getLastEventTimestamp,
  listSessions,
  openLog,
  replayLog,
} from "./log.js";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ca-log-test-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// generateSessionId
// ---------------------------------------------------------------------------
describe("generateSessionId", () => {
  it("produces a non-empty alphanumeric string", () => {
    expect(generateSessionId()).toMatch(/^[a-z0-9]+$/);
  });

  it("is at least 8 characters (base-36 timestamp + 4 random)", () => {
    expect(generateSessionId().length).toBeGreaterThanOrEqual(8);
  });

  it("generates unique ids across many calls", () => {
    const ids = new Set(Array.from({ length: 50 }, generateSessionId));
    expect(ids.size).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// openLog + replayLog
// ---------------------------------------------------------------------------
describe("openLog / replayLog round-trip", () => {
  it("reconstructs user, assistant, and tool messages in order", async () => {
    const path = join(tmpDir, "session.jsonl");
    const log = openLog(path);

    log.write({
      type: "session_meta",
      ts: "2026-01-01T00:00:00.000Z",
      sessionId: "s1",
      cwd: "/tmp",
      model: "test",
    });
    log.write({
      type: "user_message",
      ts: "2026-01-01T00:01:00.000Z",
      content: [{ type: "text", text: "hello" }],
    });
    log.write({
      type: "assistant_chunk",
      ts: "2026-01-01T00:02:00.000Z",
      content: [{ type: "text", text: "world" }],
    });
    log.write({
      type: "tool_result",
      ts: "2026-01-01T00:03:00.000Z",
      toolUseId: "tc1",
      content: [{ type: "toolResult", toolCallId: "tc1", output: "file contents", isError: false }],
    });
    await log.close();

    const messages = replayLog(path);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "world" }],
    });
    expect(messages[2]).toEqual({
      role: "tool",
      content: [{ type: "toolResult", toolCallId: "tc1", output: "file contents", isError: false }],
    });
  });

  it("session_clear resets message history at that point in the log", async () => {
    const path = join(tmpDir, "session.jsonl");
    const log = openLog(path);
    log.write({ type: "user_message", ts: "t1", content: [{ type: "text", text: "before" }] });
    log.write({ type: "assistant_chunk", ts: "t2", content: [{ type: "text", text: "reply" }] });
    log.write({ type: "session_clear", ts: "t3" });
    log.write({ type: "user_message", ts: "t4", content: [{ type: "text", text: "after" }] });
    await log.close();

    const messages = replayLog(path);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user" });
    expect(messages[0]?.content[0]).toMatchObject({ text: "after" });
  });

  it("skips session_meta events entirely on replay", async () => {
    const path = join(tmpDir, "session.jsonl");
    const log = openLog(path);
    log.write({ type: "session_meta", ts: "t1", sessionId: "s1", cwd: "/", model: "m" });
    log.write({ type: "user_message", ts: "t2", content: [{ type: "text", text: "hi" }] });
    await log.close();

    expect(replayLog(path)).toHaveLength(1);
  });

  it("ignores unknown future event types gracefully", () => {
    const path = join(tmpDir, "session.jsonl");
    writeFileSync(
      path,
      '{"type":"unknown_future_event","ts":"t1"}\n' +
        '{"type":"user_message","ts":"t2","content":[{"type":"text","text":"ok"}]}\n',
    );
    expect(replayLog(path)).toHaveLength(1);
  });

  it("skips malformed JSON lines without throwing", () => {
    const path = join(tmpDir, "session.jsonl");
    writeFileSync(
      path,
      'NOT JSON\n' +
        '{"type":"user_message","ts":"t1","content":[{"type":"text","text":"ok"}]}\n',
    );
    expect(replayLog(path)).toHaveLength(1);
  });

  it("returns an empty array for a missing file", () => {
    expect(replayLog(join(tmpDir, "nonexistent.jsonl"))).toEqual([]);
  });

  it("creates intermediate directories that do not exist", async () => {
    const path = join(tmpDir, "deep", "nested", "session.jsonl");
    const log = openLog(path);
    log.write({ type: "user_message", ts: "t1", content: [] });
    await log.close();
    expect(replayLog(path)).toHaveLength(1);
  });

  it("appends to an existing log file", async () => {
    const path = join(tmpDir, "session.jsonl");
    const log1 = openLog(path);
    log1.write({ type: "user_message", ts: "t1", content: [{ type: "text", text: "first" }] });
    await log1.close();

    const log2 = openLog(path);
    log2.write({ type: "user_message", ts: "t2", content: [{ type: "text", text: "second" }] });
    await log2.close();

    expect(replayLog(path)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// getLastEventTimestamp
// ---------------------------------------------------------------------------
describe("getLastEventTimestamp", () => {
  it("returns the ts of the last event in the file", () => {
    const path = join(tmpDir, "session.jsonl");
    writeFileSync(
      path,
      '{"type":"session_meta","ts":"2026-01-01T00:00:00.000Z","sessionId":"s1","cwd":"/","model":"m"}\n' +
        '{"type":"user_message","ts":"2026-01-01T00:05:00.000Z","content":[]}\n',
    );
    expect(getLastEventTimestamp(path)).toBe("2026-01-01T00:05:00.000Z");
  });

  it("returns undefined for a missing file", () => {
    expect(getLastEventTimestamp(join(tmpDir, "missing.jsonl"))).toBeUndefined();
  });

  it("skips malformed trailing lines and returns the last valid ts", () => {
    const path = join(tmpDir, "session.jsonl");
    writeFileSync(
      path,
      '{"type":"user_message","ts":"2026-01-01T00:01:00.000Z","content":[]}\n' + "NOT JSON\n",
    );
    expect(getLastEventTimestamp(path)).toBe("2026-01-01T00:01:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------
describe("listSessions", () => {
  it("returns an empty array when the directory does not exist", () => {
    expect(listSessions(join(tmpDir, "no-such-dir"))).toEqual([]);
  });

  it("returns summaries with correct metadata and turn counts", async () => {
    const sessionsPath = join(tmpDir, "sessions");

    const log = openLog(join(sessionsPath, "abc123.jsonl"));
    log.write({
      type: "session_meta",
      ts: "2026-01-01T00:00:00.000Z",
      sessionId: "abc123",
      cwd: "/projects/foo",
      model: "test-model",
    });
    log.write({ type: "user_message", ts: "2026-01-01T00:01:00.000Z", content: [] });
    log.write({ type: "assistant_chunk", ts: "2026-01-01T00:02:00.000Z", content: [] });
    log.write({ type: "user_message", ts: "2026-01-01T00:03:00.000Z", content: [] });
    await log.close();

    const summaries = listSessions(sessionsPath);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      sessionId: "abc123",
      cwd: "/projects/foo",
      model: "test-model",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastTs: "2026-01-01T00:03:00.000Z",
      turns: 2,
    });
  });

  it("returns multiple sessions sorted newest-first (by filename desc)", async () => {
    const sessionsPath = join(tmpDir, "sessions");

    for (const id of ["aaa111", "zzz999"]) {
      const log = openLog(join(sessionsPath, `${id}.jsonl`));
      log.write({ type: "session_meta", ts: "2026-01-01T00:00:00.000Z", sessionId: id, cwd: "/", model: "m" });
      await log.close();
    }

    const ids = listSessions(sessionsPath).map((s) => s.sessionId);
    expect(ids).toEqual(["zzz999", "aaa111"]);
  });

  it("skips files without a session_meta event", async () => {
    const sessionsPath = join(tmpDir, "sessions");
    const log = openLog(join(sessionsPath, "nometasession.jsonl"));
    log.write({ type: "user_message", ts: "t1", content: [] });
    await log.close();

    expect(listSessions(sessionsPath)).toHaveLength(0);
  });
});
