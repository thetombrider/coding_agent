/**
 * delegate_read implementation — one-shot cheap-model Q&A over file contents.
 * Reads paths into a tagged corpus, sends a single OpenRouter completion (no sub-loop).
 */
import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { generateText } from "ai";
import { defaultCheapModel } from "../config/models.js";
import { getOpenRouter, resolveOpenRouterModelId } from "../provider/openrouter.js";
import { resolvePath } from "../util/paths.js";
import { findMatchingFiles } from "../tools/find.js";

export const DELEGATE_READ_SYSTEM = (
  "You are a precise code analyst. Answer questions about the provided files "
  + "accurately and concisely. Quote file paths and line numbers when relevant."
);

export interface DelegateReadOptions {
  task: string;
  paths?: string[];
  cwd: string;
  model?: string;
  signal?: AbortSignal;
}

export interface DelegateReadResult {
  answer: string;
  warnings: string[];
}

async function resolveInputPaths(cwd: string, paths?: string[]): Promise<{
  files: string[];
  warnings: string[];
}> {
  if (!paths?.length) return { files: [], warnings: [] };

  const files: string[] = [];
  const warnings: string[] = [];

  for (const path of paths) {
    if (path.includes("*")) {
      const matches = await findMatchingFiles(cwd, path);
      if (!matches.length) warnings.push(`Warning: ${path} matched no files, skipping.`);
      files.push(...matches);
      continue;
    }

    const full = resolvePath(cwd, path);
    try {
      const info = await stat(full);
      if (info.isDirectory()) {
        warnings.push(`Warning: ${path} is a directory, skipping.`);
        continue;
      }
      files.push(relative(cwd, full) || path);
    } catch {
      warnings.push(`Warning: ${path} not found, skipping.`);
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
) => Promise<{ text: string }>;

export async function runDelegateRead(
  options: DelegateReadOptions,
  generate: DelegateReadGenerate = generateText,
): Promise<DelegateReadResult> {
  const { files, warnings } = await resolveInputPaths(options.cwd, options.paths);
  const contents = new Map<string, string>();

  for (const path of files) {
    const full = resolvePath(options.cwd, path);
    contents.set(path, await readFile(full, "utf8"));
  }

  const corpus = buildDelegateReadCorpus(files, contents);
  const model = options.model ?? defaultCheapModel();

  const { text } = await generate({
    model: getOpenRouter().chat(resolveOpenRouterModelId(model)),
    system: DELEGATE_READ_SYSTEM,
    messages: buildDelegateReadMessages(corpus, options.task),
    maxOutputTokens: 8192,
    abortSignal: options.signal,
  });

  return { answer: text, warnings };
}
