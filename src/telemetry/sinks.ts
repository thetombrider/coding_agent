import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { MetricEvent } from "./events.js";

/** A destination for metric events. `flush` is optional and terminal (called at session end). */
export interface MetricSink {
  emit(event: MetricEvent): void;
  flush?(): void | Promise<void>;
}

/** Emit an event to every sink, isolating failures so one bad sink can't break the others. */
export function emitAll(sinks: readonly MetricSink[], event: MetricEvent): void {
  for (const sink of sinks) {
    try {
      sink.emit(event);
    } catch {
      // A throwing sink must never propagate into the agent loop.
    }
  }
}

/** Flush every sink that supports it, isolating per-sink failures. */
export async function flushAll(sinks: readonly MetricSink[]): Promise<void> {
  for (const sink of sinks) {
    try {
      await sink.flush?.();
    } catch {
      // ignore flush failures
    }
  }
}

/** Expand a leading `~` to the user's home directory. */
function expandHome(filePath: string): string {
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/")) return join(homedir(), filePath.slice(2));
  return filePath;
}

/** Append metric events as JSON lines to a file (default `~/.orin/metrics.jsonl`). */
export function jsonlSink(filePath?: string): MetricSink {
  const path = expandHome(filePath ?? join(homedir(), ".orin", "metrics.jsonl"));
  let stream: WriteStream | undefined;
  // WriteStream surfaces failures (disk full, EPIPE) asynchronously via the
  // "error" event; without a listener Node would throw and crash the process.
  // Latch the failure and drop further writes so telemetry stays best-effort.
  let failed = false;
  const ensure = (): WriteStream => {
    if (!stream) {
      mkdirSync(dirname(path), { recursive: true });
      stream = createWriteStream(path, { flags: "a" });
      stream.on("error", () => {
        failed = true;
        stream = undefined;
      });
    }
    return stream;
  };
  return {
    emit(event) {
      if (failed) return;
      ensure().write(JSON.stringify(event) + "\n");
    },
    flush() {
      return new Promise<void>((resolve) => {
        if (!stream) return resolve();
        const s = stream;
        stream = undefined;
        s.once("error", () => resolve());
        s.end(() => resolve());
      });
    },
  };
}

/** Print metric events as JSON lines to stdout. Gated by the caller (`telemetry.stdout`). */
export function stdoutSink(): MetricSink {
  return {
    emit(event) {
      process.stdout.write(JSON.stringify(event) + "\n");
    },
  };
}

/**
 * Forward metric events to an injected writer — used to persist metrics into
 * the active session log. Always fires regardless of the telemetry opt-out.
 */
export function sessionLogSink(write: (event: MetricEvent) => void): MetricSink {
  return {
    emit(event) {
      write(event);
    },
  };
}
