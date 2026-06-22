import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitAll,
  flushAll,
  jsonlSink,
  sessionLogSink,
  stdoutSink,
  type MetricSink,
} from "./sinks.js";
import type { MetricEvent } from "./events.js";

type ToolEvent = Extract<MetricEvent, { type: "tool" }>;

const event = (): ToolEvent => ({
  type: "tool",
  sessionId: "s1",
  ts: "2026-01-01T00:00:00.000Z",
  id: "t1",
  name: "read",
  durationMs: 5,
});

describe("emitAll", () => {
  it("delivers the event to every sink", () => {
    const seen: MetricEvent[] = [];
    const a: MetricSink = { emit: (e) => seen.push(e) };
    const b: MetricSink = { emit: (e) => seen.push(e) };
    const ev = event();
    emitAll([a, b], ev);
    expect(seen).toEqual([ev, ev]);
  });

  it("isolates a throwing sink so others still receive the event", () => {
    const seen: MetricEvent[] = [];
    const bad: MetricSink = {
      emit() {
        throw new Error("boom");
      },
    };
    const good: MetricSink = { emit: (e) => seen.push(e) };
    expect(() => emitAll([bad, good], event())).not.toThrow();
    expect(seen).toHaveLength(1);
  });
});

describe("flushAll", () => {
  it("flushes sinks that support it and skips those that don't", async () => {
    let flushed = false;
    const withFlush: MetricSink = { emit: () => {}, flush: () => { flushed = true; } };
    const withoutFlush: MetricSink = { emit: () => {} };
    await flushAll([withFlush, withoutFlush]);
    expect(flushed).toBe(true);
  });

  it("isolates a rejecting flush", async () => {
    const bad: MetricSink = { emit: () => {}, flush: () => Promise.reject(new Error("x")) };
    let secondFlushed = false;
    const good: MetricSink = { emit: () => {}, flush: () => { secondFlushed = true; } };
    await expect(flushAll([bad, good])).resolves.toBeUndefined();
    expect(secondFlushed).toBe(true);
  });
});

describe("sessionLogSink", () => {
  it("forwards events to the injected writer", () => {
    const written: MetricEvent[] = [];
    const sink = sessionLogSink((e) => written.push(e));
    const ev = event();
    sink.emit(ev);
    expect(written).toEqual([ev]);
  });
});

describe("jsonlSink", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orin-sinks-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends events as JSON lines and creates parent dirs", async () => {
    const path = join(dir, "nested", "metrics.jsonl");
    const sink = jsonlSink(path);
    const ev = event();
    const ev2: ToolEvent = { ...event(), id: "t2" };
    sink.emit(ev);
    sink.emit(ev2);
    await sink.flush?.();

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(ev);
    expect(JSON.parse(lines[1]!).id).toBe("t2");
  });

  it("flush resolves cleanly when nothing was ever written", async () => {
    const sink = jsonlSink(join(dir, "empty.jsonl"));
    await expect(sink.flush?.()).resolves.toBeUndefined();
  });
});

describe("stdoutSink", () => {
  it("writes a JSON line to stdout", () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      stdoutSink().emit(event());
      expect(spy).toHaveBeenCalledTimes(1);
      const written = spy.mock.calls[0]![0] as string;
      expect(written.endsWith("\n")).toBe(true);
      expect(JSON.parse(written.trim()).id).toBe("t1");
    } finally {
      spy.mockRestore();
    }
  });
});
