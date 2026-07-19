import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { CheckpointRecord } from "../checkpoint/manager.js";
import { SessionCostAccumulator } from "../telemetry/accumulator.js";
import type { SessionIsolationMode } from "../agent/session-isolation.js";
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
      writeSync(fd, JSON.stringify({ type: "session_completed", ts: new Date().toISOString() }) + "\n");
      closeSync(fd);
      fd = null;
    },
  };
}

export interface ReplayRepairSummary {
  /** JSONL lines that could not be parsed and were dropped. */
  skippedMalformedLines: number;
  /** Tool results synthesized for calls left dangling by an interrupted session. */
  synthesizedToolResults: number;
}

export interface ReplayResult {
  messages: Message[];
  repairs: ReplayRepairSummary;
}

const EMPTY_REPLAY: ReplayResult = {
  messages: [],
  repairs: { skippedMalformedLines: 0, synthesizedToolResults: 0 },
};

/** Format repair actions for stderr / status hints on resume. */
export function formatReplayRepairSummary(repairs: ReplayRepairSummary): string | undefined {
  const parts: string[] = [];
  if (repairs.skippedMalformedLines > 0) {
    const n = repairs.skippedMalformedLines;
    parts.push(`${n} corrupt log line${n === 1 ? "" : "s"} skipped`);
  }
  if (repairs.synthesizedToolResults > 0) {
    const n = repairs.synthesizedToolResults;
    parts.push(`${n} interrupted tool result${n === 1 ? "" : "s"} synthesized`);
  }
  return parts.length ? `Session log repaired: ${parts.join("; ")}` : undefined;
}

export function replayLog(path: string): ReplayResult {
  if (!existsSync(path)) return EMPTY_REPLAY;
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);

  let skippedMalformedLines = 0;
  const messages: Message[] = [];
  for (const line of lines) {
    let ev: SessionEvent;
    try {
      ev = JSON.parse(line) as SessionEvent;
    } catch {
      skippedMalformedLines++;
      continue;
    }
    if (ev.type === "user_message") {
      messages.push({ role: "user", content: ev.content });
    } else if (ev.type === "assistant_chunk") {
      messages.push({ role: "assistant", content: ev.content });
    } else if (ev.type === "tool_result") {
      messages.push({ role: "tool", content: ev.content });
    } else if (ev.type === "session_clear") {
      messages.length = 0;
    }
    // session_meta, session_completed, metric, and unknown types: skip (not
    // part of the message transcript).
  }

  // Always repair dangling tool calls. A trailing session_completed only means
  // the log handle was closed — it does not guarantee every in-flight tool call
  // was persisted (e.g. kill between assistant_chunk and tool_result).
  const { messages: repaired, synthesized } = repairDanglingToolCalls(messages);
  return {
    messages: repaired,
    repairs: { skippedMalformedLines, synthesizedToolResults: synthesized },
  };
}

/**
 * Append synthetic tool results for any assistant tool call that has no matching
 * result. A session killed mid-tool-run logs the assistant message (with tool
 * calls) but never the results, leaving the transcript malformed — the next
 * provider call then fails with "Tool results are missing for tool calls …".
 * Filling the gaps keeps a resumed session well-formed and visible.
 */
export function repairDanglingToolCalls(messages: Message[]): {
  messages: Message[];
  synthesized: number;
} {
  const resolved = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    for (const block of msg.content) {
      if (block.type === "toolResult") resolved.add(block.toolCallId);
    }
  }

  let synthesized = 0;
  const repaired: Message[] = [];
  for (const msg of messages) {
    repaired.push(msg);
    if (msg.role !== "assistant") continue;
    const fillers: ContentBlock[] = [];
    for (const block of msg.content) {
      if (block.type !== "toolCall" || resolved.has(block.id)) continue;
      resolved.add(block.id);
      synthesized++;
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
  return { messages: repaired, synthesized };
}

/**
 * Verify that every assistant tool call has a matching tool result and that
 * tool-call turns are followed by a tool message. Used after replay repair.
 */
export function validateTranscriptShape(messages: Message[]): string[] {
  const resolved = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    for (const block of msg.content) {
      if (block.type === "toolResult") resolved.add(block.toolCallId);
    }
  }

  const issues: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const toolCalls = msg.content.filter(
      (c): c is Extract<ContentBlock, { type: "toolCall" }> => c.type === "toolCall",
    );
    if (toolCalls.length === 0) continue;

    const next = messages[i + 1];
    if (!next || next.role !== "tool") {
      issues.push(`assistant message at index ${i} has tool calls but is not followed by a tool message`);
    }
    for (const call of toolCalls) {
      if (!resolved.has(call.id)) {
        issues.push(`unresolved tool call ${call.id}`);
      }
    }
  }

  return issues;
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

/** Read the first `session_meta` record from a log (for resume / worktree rebind). */
export function replaySessionMeta(path: string): SessionMetaRecord | undefined {
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as SessionEvent;
      if (ev.type !== "session_meta") continue;
      return {
        sessionId: ev.sessionId,
        cwd: ev.cwd,
        model: ev.model,
        hostCwd: ev.hostCwd,
        branch: ev.branch,
        worktreeDir: ev.worktreeDir,
        isolation: ev.isolation,
      };
    } catch {
      // ignore
    }
  }
  return undefined;
}

export interface SessionMetaRecord {
  sessionId: string;
  cwd: string;
  model: string;
  hostCwd?: string;
  branch?: string;
  worktreeDir?: string;
  isolation?: SessionIsolationMode;
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
  hostCwd?: string;
  branch?: string;
  isolation?: SessionIsolationMode;
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
      let metaHostCwd = "";
      let metaBranch = "";
      let metaIsolation: SessionIsolationMode | undefined;
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
            metaHostCwd = ev.hostCwd ?? "";
            metaBranch = ev.branch ?? "";
            metaIsolation = ev.isolation;
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
        summaries.push({
          sessionId,
          cwd: metaCwd,
          model: metaModel,
          createdAt,
          lastTs,
          turns,
          costUsd,
          hostCwd: metaHostCwd || undefined,
          branch: metaBranch || undefined,
          isolation: metaIsolation,
        });
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

/** Reuse the newest zero-turn session for `hostCwd`, or allocate a fresh id. */
export function resolveStartupSessionId(
  hostCwd: string,
  opts?: { isolation?: SessionIsolationMode; scanDir?: string },
): string {
  const scanDir = opts?.scanDir;
  const latest = listSessions(scanDir)[0];
  if (!latest || latest.turns !== 0) return generateSessionId();

  if (opts?.isolation === "worktree") {
    if (latest.isolation === "worktree" && latest.hostCwd === hostCwd) {
      return latest.sessionId;
    }
    return generateSessionId();
  }

  if (latest.cwd === hostCwd && latest.isolation !== "worktree") {
    return latest.sessionId;
  }
  return generateSessionId();
}
