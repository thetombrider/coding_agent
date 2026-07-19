import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteSession,
  formatReplayRepairSummary,
  generateSessionId,
  getLastEventTimestamp,
  listSessions,
  openLog,
  rebuildSessionCost,
  replayCheckpoints,
  replayLog,
  resolveStartupSessionId,
  validateTranscriptShape,
} from "./log.js";
import { createHookRegistry } from "../hooks/registry.js";
import { installCoreHooks } from "../hooks/install.js";
import { runLoop, lastAssistantText } from "../agent/loop.js";
import { createStatefulFauxProvider } from "../provider/faux.js";
import { createLocalWorkspace } from "../workspace/local.js";
import { toAiMessages } from "../provider/stream.js";
import type { MetricEvent } from "../telemetry/events.js";

/** Build a `turn` metric line as the sessionLogSink (1/8) persists it. */
function turnMetric(
  sessionId: string,
  costUsd: number | null,
  usage: { input: number; output: number; totalTokens: number },
) {
  const event: MetricEvent = {
    type: "turn",
    sessionId,
    ts: "2026-01-01T00:00:00.000Z",
    model: "anthropic/claude-opus-4.8",
    usage: { ...usage, cacheRead: 0, cacheWrite: 0 },
    costUsd,
    pricingMissing: costUsd === null,
    source: "main_loop",
  };
  return { type: "metric" as const, ts: event.ts, event };
}

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
      content: [{ type: "toolResult", toolCallId: "tc1", toolName: "read", output: "file contents", isError: false }],
    });
    await log.close();

    const { messages } = replayLog(path);
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
      content: [{ type: "toolResult", toolCallId: "tc1", toolName: "read", output: "file contents", isError: false }],
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

    const { messages } = replayLog(path);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user" });
    expect(messages[0]?.content[0]).toMatchObject({ text: "after" });
  });

  it("replayCheckpoints reads persisted checkpoints and skips messages", async () => {
    const path = join(tmpDir, "session.jsonl");
    const log = openLog(path);
    log.write({ type: "user_message", ts: "t1", content: [{ type: "text", text: "hi" }] });
    log.write({ type: "checkpoint", ts: "t2", checkpointId: "aaa111", label: "session baseline", tool: "baseline" });
    log.write({ type: "checkpoint", ts: "t3", checkpointId: "bbb222", label: "after edit", tool: "edit" });
    await log.close();

    const cps = replayCheckpoints(path);
    expect(cps).toEqual([
      { id: "aaa111", label: "session baseline", ts: "t2", tool: "baseline" },
      { id: "bbb222", label: "after edit", ts: "t3", tool: "edit" },
    ]);
    // checkpoint events are not part of the message transcript.
    expect(replayLog(path).messages).toHaveLength(1);
  });

  it("replayCheckpoints resets on session_clear", async () => {
    const path = join(tmpDir, "session.jsonl");
    const log = openLog(path);
    log.write({ type: "checkpoint", ts: "t1", checkpointId: "aaa111", label: "baseline", tool: "baseline" });
    log.write({ type: "session_clear", ts: "t2" });
    log.write({ type: "checkpoint", ts: "t3", checkpointId: "ccc333", label: "after edit", tool: "edit" });
    await log.close();

    expect(replayCheckpoints(path).map((c) => c.id)).toEqual(["ccc333"]);
  });

  it("skips session_meta events entirely on replay", async () => {
    const path = join(tmpDir, "session.jsonl");
    const log = openLog(path);
    log.write({ type: "session_meta", ts: "t1", sessionId: "s1", cwd: "/", model: "m" });
    log.write({ type: "user_message", ts: "t2", content: [{ type: "text", text: "hi" }] });
    await log.close();

    expect(replayLog(path).messages).toHaveLength(1);
  });

  it("ignores unknown future event types gracefully", () => {
    const path = join(tmpDir, "session.jsonl");
    writeFileSync(
      path,
      '{"type":"unknown_future_event","ts":"t1"}\n' +
        '{"type":"user_message","ts":"t2","content":[{"type":"text","text":"ok"}]}\n',
    );
    expect(replayLog(path).messages).toHaveLength(1);
  });

  it("synthesizes results for tool calls left dangling by a killed session", () => {
    const path = join(tmpDir, "session.jsonl");
    const log = openLog(path);
    log.write({ type: "user_message", ts: "t1", content: [{ type: "text", text: "go" }] });
    // Assistant fired two tool calls; the process was killed before either result
    // was logged (e.g. mid bash run). Do NOT call log.close() — that would
    // write session_completed and mark the session as cleanly closed.
    log.write({
      type: "assistant_chunk",
      ts: "t2",
      content: [
        { type: "toolCall", id: "bash:8", name: "bash", arguments: { command: "ls" } },
        { type: "toolCall", id: "bash:9", name: "bash", arguments: { command: "pwd" } },
      ],
    });

    const { messages } = replayLog(path);
    // user, assistant, and a synthetic tool message filling both calls.
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: "tool",
      content: [
        { type: "toolResult", toolCallId: "bash:8", toolName: "bash", output: "[interrupted — no result recorded]", isError: true },
        { type: "toolResult", toolCallId: "bash:9", toolName: "bash", output: "[interrupted — no result recorded]", isError: true },
      ],
    });
  });

  it("leaves tool calls that already have results untouched", async () => {
    const path = join(tmpDir, "session.jsonl");
    const log = openLog(path);
    log.write({ type: "user_message", ts: "t1", content: [{ type: "text", text: "go" }] });
    log.write({
      type: "assistant_chunk",
      ts: "t2",
      content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } }],
    });
    log.write({
      type: "tool_result",
      ts: "t3",
      toolUseId: "tc1",
      content: [{ type: "toolResult", toolCallId: "tc1", toolName: "bash", output: "ok", isError: false }],
    });
    await log.close();

    const { messages } = replayLog(path);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: "tool",
      content: [{ type: "toolResult", toolCallId: "tc1", toolName: "bash", output: "ok", isError: false }],
    });
  });

  it("does not synthesize tool results when session_completed is present and results exist", async () => {
    // A cleanly closed session ends with session_completed. Repair still runs,
    // but no synthetic fillers are added when every tool call has a result.
    const path = join(tmpDir, "session.jsonl");
    const log = openLog(path);
    log.write({ type: "user_message", ts: "t1", content: [{ type: "text", text: "go" }] });
    log.write({
      type: "assistant_chunk",
      ts: "t2",
      content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } }],
    });
    log.write({
      type: "tool_result",
      ts: "t3",
      toolUseId: "tc1",
      content: [{ type: "toolResult", toolCallId: "tc1", toolName: "bash", output: "ok", isError: false }],
    });
    await log.close(); // writes session_completed

    const { messages, repairs } = replayLog(path);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: "tool",
      content: [{ type: "toolResult", toolCallId: "tc1", toolName: "bash", output: "ok", isError: false }],
    });
    expect(repairs.synthesizedToolResults).toBe(0);
    expect(validateTranscriptShape(messages)).toEqual([]);
  });

  it("repairs dangling tool calls even when session_completed is present", async () => {
    // session_completed only means the log handle closed — a kill between
    // assistant_chunk and tool_result can still leave dangling calls.
    const path = join(tmpDir, "session.jsonl");
    const log = openLog(path);
    log.write({ type: "user_message", ts: "t1", content: [{ type: "text", text: "go" }] });
    log.write({
      type: "assistant_chunk",
      ts: "t2",
      content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } }],
    });
    await log.close();

    const { messages, repairs } = replayLog(path);
    expect(messages).toHaveLength(3);
    expect(repairs.synthesizedToolResults).toBe(1);
    expect(messages[2]).toMatchObject({
      role: "tool",
      content: [expect.objectContaining({ toolCallId: "tc1", isError: true })],
    });
    expect(validateTranscriptShape(messages)).toEqual([]);
  });

  it("runs repair pass when session_completed is absent (interrupted session)", () => {
    // Write an incomplete log without session_completed (as if killed mid-run).
    const path = join(tmpDir, "session.jsonl");
    const log = openLog(path);
    log.write({ type: "user_message", ts: "t1", content: [{ type: "text", text: "go" }] });
    log.write({
      type: "assistant_chunk",
      ts: "t2",
      content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } }],
    });
    // No log.close() — simulates hard kill.

    const { messages } = replayLog(path);
    expect(messages).toHaveLength(3); // user + assistant + synthetic filler
    expect(messages[2]).toMatchObject({
      role: "tool",
      content: [expect.objectContaining({ toolCallId: "tc1", isError: true })],
    });
  });

  it("ignores metric events when reconstructing the transcript", async () => {
    const path = join(tmpDir, "session.jsonl");
    const log = openLog(path);
    log.write({ type: "user_message", ts: "t1", content: [{ type: "text", text: "hi" }] });
    log.write(turnMetric("s1", 0.01, { input: 100, output: 50, totalTokens: 150 }));
    log.write({ type: "assistant_chunk", ts: "t2", content: [{ type: "text", text: "yo" }] });
    await log.close();

    const { messages } = replayLog(path);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("skips malformed JSON lines without throwing", () => {
    const path = join(tmpDir, "session.jsonl");
    writeFileSync(
      path,
      'NOT JSON\n' +
        '{"type":"user_message","ts":"t1","content":[{"type":"text","text":"ok"}]}\n',
    );
    const { messages, repairs } = replayLog(path);
    expect(messages).toHaveLength(1);
    expect(repairs.skippedMalformedLines).toBe(1);
    expect(formatReplayRepairSummary(repairs)).toBe("Session log repaired: 1 corrupt log line skipped");
  });

  it("reports synthesized tool results in the repair summary", () => {
    const path = join(tmpDir, "session.jsonl");
    const log = openLog(path);
    log.write({ type: "user_message", ts: "t1", content: [{ type: "text", text: "go" }] });
    log.write({
      type: "assistant_chunk",
      ts: "t2",
      content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } }],
    });

    const { repairs } = replayLog(path);
    expect(repairs.synthesizedToolResults).toBe(1);
    expect(formatReplayRepairSummary(repairs)).toBe(
      "Session log repaired: 1 interrupted tool result synthesized",
    );
  });

  it("resumed interrupted session produces a provider-safe transcript and can complete a turn", async () => {
    const path = join(tmpDir, "session.jsonl");
    const log = openLog(path);
    log.write({ type: "user_message", ts: "t1", content: [{ type: "text", text: "list files" }] });
    log.write({
      type: "assistant_chunk",
      ts: "t2",
      content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } }],
    });
    // Simulate kill mid-tool — no tool_result and no session_completed.

    const { messages, repairs } = replayLog(path);
    expect(repairs.synthesizedToolResults).toBe(1);
    expect(validateTranscriptShape(messages)).toEqual([]);
    expect(() => toAiMessages(messages)).not.toThrow();

    const provider = createStatefulFauxProvider([{ text: ["Done after resume."] }]);
    const registry = createHookRegistry();
    installCoreHooks(registry, { mode: "auto-accept", autoAcceptCli: true, tools: [] });
    const ctx = {
      cwd: process.cwd(),
      messages,
      workspace: createLocalWorkspace(),
    };
    const result = await runLoop(ctx, registry, { provider, tools: [], model: "faux:test" });
    expect(lastAssistantText(result)).toBe("Done after resume.");
  });

  it("returns an empty array for a missing file", () => {
    expect(replayLog(join(tmpDir, "nonexistent.jsonl"))).toEqual({
      messages: [],
      repairs: { skippedMalformedLines: 0, synthesizedToolResults: 0 },
    });
  });

  it("creates intermediate directories that do not exist", async () => {
    const path = join(tmpDir, "deep", "nested", "session.jsonl");
    const log = openLog(path);
    log.write({ type: "user_message", ts: "t1", content: [] });
    await log.close();
    expect(replayLog(path).messages).toHaveLength(1);
  });

  it("appends to an existing log file", async () => {
    const path = join(tmpDir, "session.jsonl");
    const log1 = openLog(path);
    log1.write({ type: "user_message", ts: "t1", content: [{ type: "text", text: "first" }] });
    await log1.close();

    const log2 = openLog(path);
    log2.write({ type: "user_message", ts: "t2", content: [{ type: "text", text: "second" }] });
    await log2.close();

    expect(replayLog(path).messages).toHaveLength(2);
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
      lastTs: expect.any(String), // session_completed ts is real wall-clock time
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

  it("surfaces summed cost from persisted turn metrics", async () => {
    const sessionsPath = join(tmpDir, "sessions");
    const log = openLog(join(sessionsPath, "withcost.jsonl"));
    log.write({ type: "session_meta", ts: "t0", sessionId: "withcost", cwd: "/p", model: "m" });
    log.write({ type: "user_message", ts: "t1", content: [] });
    log.write(turnMetric("withcost", 0.04, { input: 100, output: 20, totalTokens: 120 }));
    log.write(turnMetric("withcost", 0.06, { input: 100, output: 20, totalTokens: 120 }));
    await log.close();

    const [summary] = listSessions(sessionsPath);
    expect(summary?.costUsd).toBeCloseTo(0.1);
  });

  it("leaves costUsd null when a session has no priced turns", async () => {
    const sessionsPath = join(tmpDir, "sessions");
    const log = openLog(join(sessionsPath, "nocost.jsonl"));
    log.write({ type: "session_meta", ts: "t0", sessionId: "nocost", cwd: "/p", model: "m" });
    await log.close();

    expect(listSessions(sessionsPath)[0]?.costUsd).toBeNull();
  });

  it("skips files without a session_meta event", async () => {
    const sessionsPath = join(tmpDir, "sessions");
    const log = openLog(join(sessionsPath, "nometasession.jsonl"));
    log.write({ type: "user_message", ts: "t1", content: [] });
    await log.close();

    expect(listSessions(sessionsPath)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// rebuildSessionCost
// ---------------------------------------------------------------------------
describe("rebuildSessionCost", () => {
  it("folds persisted turn metrics into an accumulator matching their sum", async () => {
    const path = join(tmpDir, "session.jsonl");
    const log = openLog(path);
    log.write({ type: "session_meta", ts: "t0", sessionId: "cost1", cwd: "/", model: "m" });
    log.write({ type: "user_message", ts: "t1", content: [] });
    log.write(turnMetric("cost1", 0.02, { input: 100, output: 20, totalTokens: 120 }));
    log.write(turnMetric("cost1", 0.03, { input: 200, output: 40, totalTokens: 240 }));
    await log.close();

    const acc = rebuildSessionCost(path);
    expect(acc).toBeDefined();
    const snap = acc!.snapshot();
    expect(snap.sessionId).toBe("cost1");
    expect(snap.turns).toBe(2);
    expect(snap.costUsd).toBeCloseTo(0.05);
    expect(snap.tokens.input).toBe(300);
    expect(snap.tokens.totalTokens).toBe(360);
  });

  it("keeps costUsd null when no priced turn was recorded", async () => {
    const path = join(tmpDir, "session.jsonl");
    const log = openLog(path);
    log.write({ type: "session_meta", ts: "t0", sessionId: "noprice", cwd: "/", model: "m" });
    log.write(turnMetric("noprice", null, { input: 10, output: 5, totalTokens: 15 }));
    await log.close();

    const snap = rebuildSessionCost(path)!.snapshot();
    expect(snap.costUsd).toBeNull();
    expect(snap.pricingMissing).toBe(true);
    expect(snap.tokens.totalTokens).toBe(15);
  });

  it("returns a zeroed accumulator for a log with no metrics", async () => {
    const path = join(tmpDir, "session.jsonl");
    const log = openLog(path);
    log.write({ type: "session_meta", ts: "t0", sessionId: "empty", cwd: "/", model: "m" });
    await log.close();

    const snap = rebuildSessionCost(path)!.snapshot();
    expect(snap.sessionId).toBe("empty");
    expect(snap.turns).toBe(0);
    expect(snap.costUsd).toBeNull();
  });

  it("returns undefined for a missing file", () => {
    expect(rebuildSessionCost(join(tmpDir, "missing.jsonl"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------
describe("deleteSession", () => {
  it("removes an existing session log file", async () => {
    const sessionsPath = join(tmpDir, "sessions");
    const log = openLog(join(sessionsPath, "todelete.jsonl"));
    log.write({
      type: "session_meta",
      ts: "2026-01-01T00:00:00.000Z",
      sessionId: "todelete",
      cwd: "/",
      model: "m",
    });
    await log.close();

    expect(deleteSession("todelete", sessionsPath)).toBe(true);
    expect(listSessions(sessionsPath)).toHaveLength(0);
  });

  it("returns false when the session file does not exist", () => {
    expect(deleteSession("missing", join(tmpDir, "sessions"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveStartupSessionId
// ---------------------------------------------------------------------------
describe("resolveStartupSessionId", () => {
  it("reuses the newest zero-turn session for the same cwd", async () => {
    const sessionsPath = join(tmpDir, "sessions");
    const log = openLog(join(sessionsPath, "empty123.jsonl"));
    log.write({
      type: "session_meta",
      ts: "2026-01-01T00:00:00.000Z",
      sessionId: "empty123",
      cwd: "/projects/foo",
      model: "m",
    });
    await log.close();

    expect(resolveStartupSessionId("/projects/foo", { scanDir: sessionsPath })).toBe("empty123");
  });

  it("allocates a new id when the latest session already has turns", async () => {
    const sessionsPath = join(tmpDir, "sessions");
    const log = openLog(join(sessionsPath, "active123.jsonl"));
    log.write({
      type: "session_meta",
      ts: "2026-01-01T00:00:00.000Z",
      sessionId: "active123",
      cwd: "/projects/foo",
      model: "m",
    });
    log.write({ type: "user_message", ts: "2026-01-01T00:01:00.000Z", content: [] });
    await log.close();

    const id = resolveStartupSessionId("/projects/foo", { scanDir: sessionsPath });
    expect(id).not.toBe("active123");
    expect(id).toMatch(/^[a-z0-9]+$/);
  });

  it("allocates a new id when the latest empty session is for a different cwd", async () => {
    const sessionsPath = join(tmpDir, "sessions");
    const log = openLog(join(sessionsPath, "othercwd.jsonl"));
    log.write({
      type: "session_meta",
      ts: "2026-01-01T00:00:00.000Z",
      sessionId: "othercwd",
      cwd: "/projects/bar",
      model: "m",
    });
    await log.close();

    const id = resolveStartupSessionId("/projects/foo", { scanDir: sessionsPath });
    expect(id).not.toBe("othercwd");
  });

  it("allocates a new id when there are no sessions", () => {
    expect(resolveStartupSessionId("/projects/foo", { scanDir: join(tmpDir, "sessions") })).toMatch(/^[a-z0-9]+$/);
  });

  it("reuses the newest zero-turn worktree session for the same host cwd", async () => {
    const sessionsPath = join(tmpDir, "sessions");
    const log = openLog(join(sessionsPath, "wtempty.jsonl"));
    log.write({
      type: "session_meta",
      ts: "2026-01-01T00:00:00.000Z",
      sessionId: "wtempty",
      cwd: "/tmp/wt/tree",
      hostCwd: "/projects/foo",
      branch: "orin/session-wtempty",
      isolation: "worktree",
      model: "m",
    });
    await log.close();

    expect(
      resolveStartupSessionId("/projects/foo", { isolation: "worktree", scanDir: sessionsPath }),
    ).toBe("wtempty");
  });
});
