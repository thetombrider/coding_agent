import { generateText } from "ai";
import { resolveLanguageModel } from "../provider/registry.js";
import { aiSdkUsageToUsage, type AiSdkUsage } from "../telemetry/cost.js";
import type { LlmCallRecorder } from "../telemetry/events.js";
import type { Message } from "../types.js";

const COMPACT_THRESHOLD = 0.85;
const DEFAULT_KEEP_LAST_K = 3;
const DEFAULT_TOOL_RESULT_TOKEN_THRESHOLD = 2000;
const DEFAULT_KEEP_LAST_N_TURNS = 20;
const ELIDED_PREFIX = "[result elided";

const SUMMARY_SYSTEM = (
  "You compress conversation history for a coding agent. "
  + "Produce a concise session summary preserving decisions, file paths, "
  + "errors, and current task state. Use this structure:\n\n"
  + "[Session summary — turns START–END]\n\n"
  + "<summary paragraphs>\n"
  + "Key decisions: ...\n"
  + "Files read: ...\n"
  + "Current working state: ..."
);

export interface TurnSlice {
  turn: number;
  start: number;
  end: number;
}

export type SummariseGenerate = (
  options: Parameters<typeof generateText>[0],
) => Promise<{ text: string; usage?: AiSdkUsage }>;

export function estimateMessageTokens(messages: Message[]): number {
  return JSON.stringify(messages).length / 4;
}

export function shouldCompact(messages: Message[], windowSize: number): boolean {
  return estimateMessageTokens(messages) > windowSize * COMPACT_THRESHOLD;
}

export function sliceTurns(messages: Message[]): TurnSlice[] {
  const slices: TurnSlice[] = [];
  let turn = 0;
  let start = 0;

  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role !== "user") continue;
    if (turn > 0) slices.push({ turn, start, end: i });
    turn += 1;
    start = i;
  }

  if (turn > 0) slices.push({ turn, start, end: messages.length });
  return slices;
}

export function currentTurnCount(messages: Message[]): number {
  return messages.filter((m) => m.role === "user").length;
}

function assignTurnIndices(messages: Message[]): number[] {
  let turn = 0;
  return messages.map((m) => {
    if (m.role === "user") turn += 1;
    return turn;
  });
}

function estimateTokens(text: string): number {
  return text.length / 4;
}

export function isElidedToolResult(text: string): boolean {
  return text.startsWith(ELIDED_PREFIX);
}

function elideToolOutput(output: string): string {
  const lines = output.split("\n").length;
  return `[result elided — ${lines} lines. Re-run tool if needed.]`;
}

/** Replace stale, large tool results with short stubs. Returns a new array. */
export function evictStaleToolResults(
  messages: Message[],
  currentTurn: number,
  keepLastK = DEFAULT_KEEP_LAST_K,
  tokenThreshold = DEFAULT_TOOL_RESULT_TOKEN_THRESHOLD,
): Message[] {
  if (currentTurn <= keepLastK) return messages;

  const cutoff = currentTurn - keepLastK;
  const turnByIndex = assignTurnIndices(messages);

  return messages.map((msg, index) => {
    if (msg.role !== "tool") return msg;
    if (turnByIndex[index]! > cutoff) return msg;

    const content = msg.content.map((block) => {
      if (block.type !== "toolResult") return block;
      if (isElidedToolResult(block.output)) return block;
      if (estimateTokens(block.output) <= tokenThreshold) return block;
      return { ...block, output: elideToolOutput(block.output) };
    });

    return { ...msg, content };
  });
}

export function stripReasoningBlocks(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const content = msg.content.filter((block) => block.type !== "reasoning");
    if (content.length === msg.content.length) return msg;
    return { ...msg, content };
  });
}

function formatMessagesForSummary(messages: Message[]): string {
  return messages
    .map((m) => {
      const parts = m.content.map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "reasoning") return "";
        if (block.type === "toolCall") {
          return `[tool_call ${block.name} ${JSON.stringify(block.arguments)}]`;
        }
        if (block.type === "toolResult") {
          const prefix = block.isError ? "[tool_error]" : "[tool_result]";
          return `${prefix} ${block.output}`;
        }
        return "";
      });
      return `${m.role}: ${parts.join("\n")}`;
    })
    .join("\n\n");
}

function prefixTurnCount(totalTurns: number, keepLastN: number): number {
  if (totalTurns <= 0) return 0;
  if (totalTurns > keepLastN) return totalTurns - keepLastN;
  return Math.floor(totalTurns / 2);
}

/** Summarise older turns into one assistant message; keep recent turns verbatim. */
export async function summariseOldTurns(
  messages: Message[],
  model: string,
  keepLastN = DEFAULT_KEEP_LAST_N_TURNS,
  generate: SummariseGenerate = generateText,
  recordCall?: LlmCallRecorder,
): Promise<Message[]> {
  const turns = sliceTurns(messages);
  const prefixTurns = prefixTurnCount(turns.length, keepLastN);
  if (prefixTurns <= 0) return messages;

  const splitAt = turns[prefixTurns - 1]!.end;
  const oldMessages = stripReasoningBlocks(messages.slice(0, splitAt));
  const recentMessages = messages.slice(splitAt);
  if (oldMessages.length === 0) return messages;

  const startTurn = turns[0]!.turn;
  const endTurn = turns[prefixTurns - 1]!.turn;
  const corpus = formatMessagesForSummary(oldMessages);

  const { text, usage } = await generate({
    model: resolveLanguageModel(model),
    system: SUMMARY_SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `Summarise turns ${startTurn}–${endTurn} of this coding-agent session:\n\n${corpus}`,
      },
    ],
    maxOutputTokens: 4096,
  });

  if (recordCall && usage) {
    recordCall({ model, usage: aiSdkUsageToUsage(usage), source: "compaction" });
  }

  const summaryMessage: Message = {
    role: "assistant",
    content: [{ type: "text", text: text.trim() }],
  };

  return [summaryMessage, ...recentMessages];
}
