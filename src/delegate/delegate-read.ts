/**
 * delegate_read implementation — one-shot cheap-model Q&A over file contents.
 * Reads paths into a tagged corpus, sends a single completion through the active
 * provider (no sub-loop).
 */
import { relative } from "node:path";
import { generateText } from "ai";
import { activeProviderId, resolveLanguageModel } from "../provider/registry.js";
import { resolveProviderSlot } from "../config/models.js";
import { resolvePath } from "../util/paths.js";
import { findMatchingFiles } from "../tools/find.js";
import { aiSdkUsageToUsage, type AiSdkUsage } from "../telemetry/cost.js";
import type { LlmCallRecorder } from "../telemetry/events.js";
import type { Workspace } from "../workspace/types.js";
import type { SymbolService } from "../symbols/service.js";

export const DELEGATE_READ_SYSTEM = (
  "You are a precise code analyst. Answer questions about the provided files "
  + "accurately and concisely. Quote file paths and line numbers when relevant."
);

export interface DelegateReadOptions {
  task: string;
  paths?: string[];
  cwd: string;
  workspace: Workspace;
  model?: string;
  signal?: AbortSignal;
  /** Optional telemetry recorder for the cheap-model call (issue 3/8). */
  record?: LlmCallRecorder;
  /** Optional symbol index for range-selective reading — reduces tokens sent to cheap model. */
  symbols?: SymbolService;
}

export interface DelegateReadResult {
  answer: string;
  warnings: string[];
}

async function resolveInputPaths(
  cwd: string,
  workspace: Workspace,
  paths?: string[],
): Promise<{
  files: string[];
  warnings: string[];
}> {
  if (!paths?.length) return { files: [], warnings: [] };

  const files: string[] = [];
  const warnings: string[] = [];

  for (const path of paths) {
    if (path.includes("*")) {
      const matches = await findMatchingFiles(workspace, cwd, path);
      if (!matches.length) warnings.push(`Warning: ${path} matched no files, skipping.`);
      files.push(...matches);
      continue;
    }

    const full = resolvePath(cwd, path);
    try {
      await workspace.readFile(full);
      files.push(relative(cwd, full) || path);
    } catch {
      try {
        await workspace.list(full);
        warnings.push(`Warning: ${path} is a directory, skipping.`);
      } catch {
        warnings.push(`Warning: ${path} not found, skipping.`);
      }
    }
  }

  return { files: [...new Set(files)], warnings };
}

export function buildDelegateReadCorpus(
  files: string[],
  contents: Map<string, string>,
): string {
  const docs = files.map(
    (path) => `<file path='${path}'>\n${contents.get(path) ?? ""}\n</file>`,
  );
  return docs.join("\n\n");
}

export function buildDelegateReadMessages(corpus: string, task: string) {
  const messages: Array<{ role: "user"; content: string }> = [];
  if (corpus) {
    messages.push({ role: "user", content: `<corpus>\n${corpus}\n</corpus>` });
  }
  messages.push({ role: "user", content: task });
  return messages;
}

const CONTEXT_PADDING = 5;

function extractTaskTerms(task: string): string[] {
  const tokens = task.match(/[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*/g) ?? [];
  return [...new Set(tokens.filter((t) => t.length >= 4))];
}

function mergeRanges(
  ranges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  if (!ranges.length) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1]!;
    const cur = sorted[i]!;
    if (cur.start <= last.end + 1) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

export function extractFileRanges(
  content: string,
  ranges: Array<{ start: number; end: number }>,
  padding = CONTEXT_PADDING,
): string {
  const lines = content.split("\n");
  const padded = ranges.map((r) => ({
    start: Math.max(1, r.start - padding),
    end: Math.min(lines.length, r.end + padding),
  }));
  const merged = mergeRanges(padded);
  return merged
    .map(({ start, end }) => `[lines ${start}-${end}]\n${lines.slice(start - 1, end).join("\n")}`)
    .join("\n\n");
}

export function selectFileContents(
  task: string,
  files: string[],
  contents: Map<string, string>,
  symbols: SymbolService,
): Map<string, string> {
  if (!symbols.ready) return contents;
  const terms = extractTaskTerms(task);
  if (!terms.length) return contents;

  const allSyms = symbols.allSymbols();
  const lowerTerms = terms.map((t) => t.toLowerCase());

  const matchesByFile = new Map<string, Array<{ start: number; end: number }>>();
  for (const sym of allSyms) {
    if (!lowerTerms.some((term) => sym.name.toLowerCase().includes(term))) continue;
    const list = matchesByFile.get(sym.file) ?? [];
    list.push({ start: sym.startLine, end: sym.endLine });
    matchesByFile.set(sym.file, list);
  }

  const result = new Map<string, string>();
  for (const file of files) {
    const content = contents.get(file);
    if (content === undefined) continue;
    const ranges = matchesByFile.get(file);
    result.set(file, ranges?.length ? extractFileRanges(content, ranges) : content);
  }
  return result;
}

/**
 * @internal inject generate in tests. Takes the model *id* (not a resolved
 * handle) so the default wrapper owns provider resolution; injected mocks never
 * touch a real provider and need no credentials.
 */
export type DelegateReadGenerate = (options: {
  model: string;
  system: string;
  messages: Array<{ role: "user"; content: string }>;
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
}) => Promise<{ text: string; usage?: AiSdkUsage }>;

const defaultDelegateReadGenerate: DelegateReadGenerate = ({ model, ...rest }) =>
  generateText({ ...rest, model: resolveLanguageModel(model) });

export async function runDelegateRead(
  options: DelegateReadOptions,
  generate: DelegateReadGenerate = defaultDelegateReadGenerate,
): Promise<DelegateReadResult> {
  const { files, warnings } = await resolveInputPaths(
    options.cwd,
    options.workspace,
    options.paths,
  );
  const contents = new Map<string, string>();

  for (const path of files) {
    const full = resolvePath(options.cwd, path);
    contents.set(path, await options.workspace.readFile(full));
  }

  const selected = options.symbols
    ? selectFileContents(options.task, files, contents, options.symbols)
    : contents;

  const corpus = buildDelegateReadCorpus(files, selected);
  const model = options.model ?? resolveProviderSlot(activeProviderId(), "delegate_read");

  const { text, usage } = await generate({
    model,
    system: DELEGATE_READ_SYSTEM,
    messages: buildDelegateReadMessages(corpus, options.task),
    maxOutputTokens: 8192,
    abortSignal: options.signal,
  });

  if (options.record && usage) {
    options.record({ model, usage: aiSdkUsageToUsage(usage), source: "delegate_read" });
  }

  return { answer: text, warnings };
}
