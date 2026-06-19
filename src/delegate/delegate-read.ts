/**
 * delegate_read implementation — one-shot cheap-model Q&A over file contents.
 * Reads paths into a tagged corpus, sends a single completion through the active
 * provider (no sub-loop).
 */
import { relative } from "node:path";
import { generateText } from "ai";
import { defaultCheapModel } from "../config/models.js";
import { resolveLanguageModel, prepareActiveProviderCredentials } from "../provider/registry.js";
import { resolvePath } from "../util/paths.js";
import { findMatchingFiles } from "../tools/find.js";
import { aiSdkUsageToUsage, type AiSdkUsage } from "../telemetry/cost.js";
import type { LlmCallRecorder } from "../telemetry/events.js";
import type { Workspace } from "../workspace/types.js";

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

/** @internal inject generate in tests */
export type DelegateReadGenerate = (
  options: Parameters<typeof generateText>[0],
) => Promise<{ text: string; usage?: AiSdkUsage }>;

export async function runDelegateRead(
  options: DelegateReadOptions,
  generate: DelegateReadGenerate = generateText,
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

  const corpus = buildDelegateReadCorpus(files, contents);
  const model = options.model ?? defaultCheapModel();

  await prepareActiveProviderCredentials();
  const { text, usage } = await generate({
    model: resolveLanguageModel(model),
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
