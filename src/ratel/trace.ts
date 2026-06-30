import { homedir } from "node:os";
import { join } from "node:path";
import type { TraceSinkConfig } from "@ratel-ai/sdk";

/** In-process trace sink — drained after gateway tool calls. */
export function ratelTraceSink(sessionId: string): TraceSinkConfig {
  return { kind: "memory", sessionId };
}

/** Optional JSONL audit log under ~/.orin/ratel-traces/. */
export function ratelJsonlTraceSink(sessionId: string): TraceSinkConfig {
  return {
    kind: "jsonl",
    sessionId,
    path: join(homedir(), ".orin", "ratel-traces", `${sessionId}.jsonl`),
  };
}
