import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { CheckpointRecord } from "../checkpoint/manager.js";
import { SessionCostAccumulator } from "../telemetry/accumulator.js";
import type { ContentBlock, Message, SessionEvent } from "../types.js";

export function sessionsDir(): string {
  return join(homedir(), ".orin", "sessions");
}

export function sessionPath(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.jsonl`);
}

export function generateSessionId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export interface LogHandle {
  write: (event: SessionEvent) => void;
  close: () => Promise<void>;
}

export function openLog(path: string): LogHandle {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Append synchronously (fd + writeSync) rather than via a buffered write
  // stream: session-log events are coarse (one line per user/assistant/tool
  // message — never per token), so the cost is negligible, and a synchronous
  // append guarantees each event reaches the OS before the call returns. A hard
  // kill can no longer drop a tool result mid-turn, which previously left the
  // resumed history with dangling tool calls.
  let fd: number | null = openSync(path, "a");
  return {
    write: (ev) => {
      if (fd === null) return;
      writeSync(fd, JSON.stringify(ev) + "\n");
    },
    close: async () => {
      if (fd === null) return;
      closeSync(fd);
      fd = null;
    },
  };
}

export function replayLog(path: string): Message[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const messages: Message[] = [];
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as SessionEvent;
      if (ev.type === "user_message") {
        messages.push({ role: "user", content: ev.content });
      } else if (ev.type === "assistant_chunk") {
        messages.push({ role: "assistant", content: ev.content });
      } else if (ev.type === "tool_result") {
        messages.push({ role: "tool", content: ev.content });
      } else if (ev.type === "session_clear") {
        messages.length = 0;
      }
      // session_meta, metric, and unknown types: skip (not part of the message
      // transcript — metric events carry cost/usage telemetry only).
    } catch {
      // ignore malformed lines
    }
  }
  return repairDanglingToolCalls(messages);
}

/**
 * Append synthetic tool results for any assistant tool call that has no matching
 * result. A session killed mid-tool-run logs the assistant message (with tool
 * calls) but never the results, leaving the transcript malformed — the next
 * provider call then fails with "Tool results are missing for tool calls …".
 * Filling the gaps keeps a resumed session well-formed and visible.
 */
export function repairDanglingToolCalls(messages: Message[]): Message[] {
  const resolved = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    for (const block of msg.content) {
      if (block.type === "toolResult") resolved.add(block.toolCallId);
    }
  }

  const repaired: Message[] = [];
  for (const msg of messages) {
    repaired.push(msg);
    if (msg.role !== "assistant") continue;
    const fillers: ContentBlock[] = [];
    for (const block of msg.content) {
      if (block.type !== "toolCall" || resolved.has(block.id)) continue;
      resolved.add(block.id);
      fillers.push({
        type: "toolResult",
        toolCallId: block.id,
        toolName: block.name,
        output: "[interrupted — no result recorded]",
        isError: true,
      });
    }
    if (fillers.length) repaired.push({ role: "tool", content: fillers });
  }
  return repaired;
}

/** Replay a session log's persisted checkpoints so /restore works after resume. */
export function replayCheckpoints(path: string): CheckpointRecord[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const records: CheckpointRecord[] = [];
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as SessionEvent;
      if (ev.type === "checkpoint") {
        records.push({ id: ev.checkpointId, label: ev.label, ts: ev.ts, tool: ev.tool });
      } else if (ev.type === "session_clear") {
        records.length = 0;
      }
    } catch {
      // ignore malformed lines
    }
  }
  return records;
}

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  model: string;
  createdAt: string;
  lastTs: string;
  turns: number;
  /** Summed cost of persisted `turn` metrics; `null` when nothing was priced. */
  costUsd?: number | null;
}

/**
 * Replay a session log's persisted `turn` metrics back into a fresh
 * {@link SessionCostAccumulator}. Used on resume to seed the running total so the
 * TUI header is correct before the next turn. Returns `undefined` only when the
 * file is missing; an existing log with no metrics yields a zeroed accumulator.
 */
export function rebuildSessionCost(path: string): SessionCostAccumulator | undefined {
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const turns: Array<Extract<SessionEvent, { type: "metric" }>["event"] & { type: "turn" }> = [];
  let sessionId: string | undefined;
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as SessionEvent;
      if (ev.type === "session_meta") {
        sessionId ??= ev.sessionId;
      } else if (ev.type === "metric" && ev.event.type === "turn") {
        sessionId ??= ev.event.sessionId;
        turns.push(ev.event);
      }
    } catch {
      // ignore malformed lines
    }
  }
  const acc = new SessionCostAccumulator(sessionId ?? basename(path, ".jsonl"));
  for (const turn of turns) acc.recordTurn(turn, turn.source);
  return acc;
}

export function getLastEventTimestamp(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]) as { ts?: string };
        if (ev.ts) return ev.ts;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return undefined;
}

export function listSessions(scanDir?: string): SessionSummary[] {
  const dir = scanDir ?? sessionsDir();
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse();

  const summaries: SessionSummary[] = [];

  for (const file of files) {
    const sessionId = file.replace(".jsonl", "");
    const path = join(dir, file);
    try {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      let metaCwd = "";
      let metaModel = "";
      let createdAt = "";
      let lastTs = "";
      let turns = 0;
      let costUsd: number | null = null;

      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as SessionEvent;
          if (ev.ts) lastTs = ev.ts;
          if (ev.type === "session_meta") {
            metaCwd = ev.cwd;
            metaModel = ev.model;
            createdAt = ev.ts;
          } else if (ev.type === "user_message") {
            turns++;
          } else if (ev.type === "metric" && ev.event.type === "turn" && ev.event.costUsd !== null) {
            costUsd = (costUsd ?? 0) + ev.event.costUsd;
          }
        } catch {
          // ignore
        }
      }

      if (metaCwd) {
        summaries.push({ sessionId, cwd: metaCwd, model: metaModel, createdAt, lastTs, turns, costUsd });
      }
    } catch {
      // ignore unreadable files
    }
  }

  return summaries;
}

/** Remove a session log file from disk. Returns false if the file is missing. */
export function deleteSession(sessionId: string, scanDir?: string): boolean {
  const path = sessionPath(sessionId);
  const resolved = scanDir ? join(scanDir, `${sessionId}.jsonl`) : path;
  if (!existsSync(resolved)) return false;
  unlinkSync(resolved);
  return true;
}

/** Reuse the newest zero-turn session for `cwd`, or allocate a fresh id. */
export function resolveStartupSessionId(cwd: string, scanDir?: string): string {
  const latest = listSessions(scanDir)[0];
  if (latest && latest.turns === 0 && latest.cwd === cwd) {
    return latest.sessionId;
  }
  return generateSessionId();
}
