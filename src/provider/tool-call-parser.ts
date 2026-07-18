import type { AssistantMessage } from "./types.js";

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

let idCounter = 0;

function nextParsedId(): string {
  idCounter += 1;
  return `parsed-${Date.now()}-${idCounter}`;
}

function parseParameterTags(innerXml: string): Record<string, unknown> {
  const parameters: Record<string, unknown> = {};
  const regex = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(innerXml)) !== null) {
    const [, paramName, rawValue] = match;
    const trimmed = rawValue.trim();
    try {
      parameters[paramName] = JSON.parse(trimmed) as unknown;
    } catch {
      parameters[paramName] = trimmed;
    }
  }

  return parameters;
}

function parseNamedToolCallBlocks(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const regex = /<tool_call\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool_call>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const [, name, inner] = match;
    calls.push({
      id: nextParsedId(),
      name,
      arguments: parseParameterTags(inner),
    });
  }

  return calls;
}

function parseToolNameBlocks(text: string, knownTools?: Set<string>): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const regex = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const [, toolName, inner] = match;
    if (toolName === "tool_call") continue;
    if (knownTools && !knownTools.has(toolName)) continue;
    if (!/<\w+>/.test(inner)) continue;

    calls.push({
      id: nextParsedId(),
      name: toolName,
      arguments: parseParameterTags(inner),
    });
  }

  return calls;
}

export function parseXmlToolCalls(
  text: string,
  knownTools?: Set<string>,
): ParsedToolCall[] | null {
  const named = parseNamedToolCallBlocks(text);
  if (named.length > 0) return named;

  const byToolName = parseToolNameBlocks(text, knownTools);
  return byToolName.length > 0 ? byToolName : null;
}

function normalizeJsonToolCall(value: unknown): ParsedToolCall | null {
  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;
  const name =
    (typeof record.name === "string" && record.name) ||
    (typeof record.tool === "string" && record.tool) ||
    (typeof record.tool_name === "string" && record.tool_name) ||
    (typeof record.function === "string" && record.function) ||
    null;

  if (!name) return null;

  const args =
    record.arguments ??
    record.args ??
    record.parameters ??
    record.input ??
    {};

  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;

  return {
    id: nextParsedId(),
    name,
    arguments: args,
  };
}

function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const fenced = text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?```/gi);
  for (const match of fenced) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    candidates.push(trimmed);
  }

  return candidates;
}

export function parseJsonToolCalls(text: string): ParsedToolCall[] | null {
  for (const candidate of extractJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const values = Array.isArray(parsed) ? parsed : [parsed];
      const calls = values
        .map((value) => normalizeJsonToolCall(value))
        .filter((value): value is ParsedToolCall => value !== null);

      if (calls.length > 0) return calls;
    } catch {
      continue;
    }
  }

  return null;
}

export function parseToolCallsFromText(
  text: string,
  knownTools?: Set<string>,
): ParsedToolCall[] | null {
  return parseXmlToolCalls(text, knownTools) ?? parseJsonToolCalls(text);
}

export interface EnrichedAssistantMessage {
  message: AssistantMessage;
  usedFallback: boolean;
}

export function enrichAssistantMessage(
  message: AssistantMessage,
  knownTools?: Set<string>,
): EnrichedAssistantMessage {
  const hasToolCalls = message.content.some((block) => block.type === "toolCall");
  if (hasToolCalls) {
    return { message, usedFallback: false };
  }

  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (!text.trim()) {
    return { message, usedFallback: false };
  }

  const parsed = parseToolCallsFromText(text, knownTools);
  if (!parsed?.length) {
    return { message, usedFallback: false };
  }

  const content: AssistantMessage["content"] = [...message.content];
  for (const call of parsed) {
    content.push({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
  }

  return {
    message: {
      ...message,
      content,
      stopReason: "tool_calls",
      toolCallsFromText: true,
    },
    usedFallback: true,
  };
}

export function formatToolValidationErrors(
  errors: Array<{ name: string; message: string }>,
  fromText = false,
): string {
  const details = errors.map((e) => `- ${e.name}: ${e.message}`).join("\n");
  const hint = fromText
    ? "Please fix the arguments and try again using valid XML or JSON tool call format."
    : "Please fix the arguments and try again.";
  return [
    "Your tool call arguments were invalid:",
    details,
    "",
    hint,
  ].join("\n");
}

export function formatEditMismatchError(details: {
  oldText: string;
  similarity: number;
  closestCandidate: string;
  closestLine: number;
  context: string;
  triedMatchers: string[];
}): string {
  const pct = Math.round(details.similarity * 100);
  const preview =
    details.oldText.length > 120
      ? `${details.oldText.slice(0, 120)}…`
      : details.oldText;

  return [
    "The edit could not be applied — oldText did not match the file.",
    "",
    `Your oldText (preview): ${JSON.stringify(preview)}`,
    "",
    `Closest match (${pct}% similar) at line ${details.closestLine}:`,
    details.context,
    "",
    `Matchers tried: ${details.triedMatchers.join(", ")}.`,
    "",
    "Fix oldText to match the file exactly, or add a startLine hint to disambiguate non-unique text.",
    "Use grep or read to verify the current file content before retrying.",
  ].join("\n");
}
