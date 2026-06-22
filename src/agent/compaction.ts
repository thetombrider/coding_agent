import { generateText } from "ai";
import { resolveLanguageModel } from "../provider/registry.js";
import { aiSdkUsageToUsage, type AiSdkUsage } from "../telemetry/cost.js";
import type { LlmCallRecorder } from "../telemetry/events.js";
import type { Message } from "../types.js";

const COMPACT_THRESHOLD = 0.85;
const DEFAULT_KEEP_LAST_K = 3;
const DEFAULT_TOOL_RESULT_TOKEN_THRESHOLD = 2000;
const DEFAULT_KEEP_LAST_N_TURNS = 20;
/** Recent tool-output budget preserved when pruning under overflow (opencode-style). */
const PRUNE_PROTECT_TOKENS = 40_000;
/** Skip pruning when it would free fewer tokens than this. */
const PRUNE_MINIMUM_TOKENS = 20_000;
/** Hard cap on a single tool result when context is near the window. */
const MAX_TOOL_RESULT_TOKENS = 16_000;
/** Message-level cut budget when turn-based summarisation cannot help (pi-style). */
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const ELIDED_PREFIX = "[result elided";

/**
 * The budgets above are absolute token counts tuned for large (~200k) windows.
 * On a small window — e.g. a cheap explore subagent model with a 32k window —
 * those absolutes can exceed the window itself, so pruning/eviction free
 * nothing and the context never drops below the limit. The provider then
 * rejects the oversized request and the (sub)agent loop throws (issue #183).
 * Scaling each budget to a fraction of the live window guarantees compaction
 * makes progress no matter how small the window, while leaving large windows
 * untouched (the absolute is the floor of the two).
 */
function scaleToWindow(absolute: number, contextWindow: number, fraction: number): number {
  return Math.max(1, Math.min(absolute, Math.floor(contextWindow * fraction)));
}

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

/**
 * Generate seam for summarisation. Takes the model *id* (not a resolved
 * handle) so the default wrapper owns provider resolution; tests inject a mock
 * and never touch a real provider (no credentials required).
 */
export type SummariseGenerate = (options: {
  model: string;
  system: string;
  messages: Array<{ role: "user"; content: string }>;
  maxOutputTokens: number;
}) => Promise<{ text: string; usage?: AiSdkUsage }>;

const defaultSummariseGenerate: SummariseGenerate = ({ model, ...rest }) =>
  generateText({ ...rest, model: resolveLanguageModel(model) });

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

function mapToolResults(
  messages: Message[],
  fn: (output: string, block: Extract<Message["content"][number], { type: "toolResult" }>) => string,
): Message[] {
  return messages.map((msg) => {
    if (msg.role !== "tool") return msg;
    const content = msg.content.map((block) => {
      if (block.type !== "toolResult") return block;
      if (isElidedToolResult(block.output)) return block;
      const next = fn(block.output, block);
      return next === block.output ? block : { ...block, output: next };
    });
    const changed = content.some((block, i) => block !== msg.content[i]);
    return changed ? { ...msg, content } : msg;
  });
}

/** Cap individual bloated tool results when nearing the context window. */
export function capOversizedToolResults(messages: Message[], contextWindow: number): Message[] {
  if (!shouldCompact(messages, contextWindow)) return messages;
  const maxResult = scaleToWindow(MAX_TOOL_RESULT_TOKENS, contextWindow, 0.25);
  return mapToolResults(messages, (output) =>
    estimateTokens(output) > maxResult ? elideToolOutput(output) : output,
  );
}

/**
 * Walk backwards and elide older tool output once the recent budget is full.
 * Works within a single user turn — unlike turn-based eviction.
 */
export function pruneOverflowToolResults(messages: Message[], contextWindow: number): Message[] {
  if (!shouldCompact(messages, contextWindow)) return messages;

  const protectBudget = scaleToWindow(PRUNE_PROTECT_TOKENS, contextWindow, 0.5);
  const minimumToPrune = scaleToWindow(PRUNE_MINIMUM_TOKENS, contextWindow, 0.25);
  let protectedTokens = 0;
  let prunedTokens = 0;
  const elideIndices = new Set<number>();

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "tool") continue;
    for (const block of msg.content) {
      if (block.type !== "toolResult") continue;
      if (isElidedToolResult(block.output)) continue;
      const tokens = estimateTokens(block.output);
      if (protectedTokens + tokens <= protectBudget) {
        protectedTokens += tokens;
        continue;
      }
      prunedTokens += tokens;
      elideIndices.add(i);
    }
  }

  if (prunedTokens < minimumToPrune) return messages;

  return messages.map((msg, index) => {
    if (!elideIndices.has(index) || msg.role !== "tool") return msg;
    const content = msg.content.map((block) => {
      if (block.type !== "toolResult") return block;
      if (isElidedToolResult(block.output)) return block;
      return { ...block, output: elideToolOutput(block.output) };
    });
    return { ...msg, content };
  });
}

function isValidCutPoint(msg: Message): boolean {
  return msg.role === "user" || msg.role === "assistant";
}

/** Index of the first message to keep when preserving a recent token budget. */
export function findMessageCutIndex(messages: Message[], keepRecentTokens: number): number {
  const cutPoints: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isValidCutPoint(messages[i]!)) cutPoints.push(i);
  }
  if (cutPoints.length === 0) return messages.length;

  let accumulated = 0;
  for (let ci = cutPoints.length - 1; ci >= 0; ci--) {
    const start = cutPoints[ci]!;
    accumulated += estimateMessageTokens(messages.slice(start));
    if (accumulated >= keepRecentTokens) return start;
  }
  return cutPoints[0] ?? 0;
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
  generate: SummariseGenerate = defaultSummariseGenerate,
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
    model,
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

/** Summarise older messages when turn boundaries cannot split the context (single-turn sessions). */
export async function summariseOldMessages(
  messages: Message[],
  model: string,
  keepRecentTokens = DEFAULT_KEEP_RECENT_TOKENS,
  generate: SummariseGenerate = defaultSummariseGenerate,
  recordCall?: LlmCallRecorder,
): Promise<Message[]> {
  const cutIndex = findMessageCutIndex(messages, keepRecentTokens);
  if (cutIndex <= 0) return messages;

  const oldMessages = stripReasoningBlocks(messages.slice(0, cutIndex));
  const recentMessages = messages.slice(cutIndex);
  if (oldMessages.length === 0) return messages;

  const corpus = formatMessagesForSummary(oldMessages);
  const { text, usage } = await generate({
    model,
    system: SUMMARY_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Summarise this portion of a coding-agent session:\n\n${corpus}`,
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

/**
 * Full auto-compact pipeline: cap/prune tool output, then summarise by turn or
 * by message cut when a single turn has grown too large.
 */
export async function compactMessages(
  messages: Message[],
  model: string,
  contextWindow: number,
  keepLastNTurns = DEFAULT_KEEP_LAST_N_TURNS,
  generate: SummariseGenerate = defaultSummariseGenerate,
  recordCall?: LlmCallRecorder,
): Promise<Message[]> {
  let result = capOversizedToolResults(messages, contextWindow);
  result = pruneOverflowToolResults(result, contextWindow);
  if (!shouldCompact(result, contextWindow)) return result;

  result = await summariseOldTurns(result, model, keepLastNTurns, generate, recordCall);
  if (!shouldCompact(result, contextWindow)) return result;

  const keepRecent = scaleToWindow(DEFAULT_KEEP_RECENT_TOKENS, contextWindow, 0.4);
  return summariseOldMessages(result, model, keepRecent, generate, recordCall);
}
