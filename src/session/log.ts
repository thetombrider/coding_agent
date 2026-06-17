import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Message, SessionEvent } from "../types.js";

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
  const stream = createWriteStream(path, { flags: "a" });
  return {
    write: (ev) => stream.write(JSON.stringify(ev) + "\n"),
    close: () => new Promise<void>((resolve, reject) => {
      stream.end((err?: Error | null) => {
        if (err) reject(err); else resolve();
      });
    }),
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
      // session_meta and unknown types: skip
    } catch {
      // ignore malformed lines
    }
  }
  return messages;
}

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  model: string;
  createdAt: string;
  lastTs: string;
  turns: number;
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
          }
        } catch {
          // ignore
        }
      }

      if (metaCwd) {
        summaries.push({ sessionId, cwd: metaCwd, model: metaModel, createdAt, lastTs, turns });
      }
    } catch {
      // ignore unreadable files
    }
  }

  return summaries;
}

/** Reuse the newest zero-turn session for `cwd`, or allocate a fresh id. */
export function resolveStartupSessionId(cwd: string, scanDir?: string): string {
  const latest = listSessions(scanDir)[0];
  if (latest && latest.turns === 0 && latest.cwd === cwd) {
    return latest.sessionId;
  }
  return generateSessionId();
}
