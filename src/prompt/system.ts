import { discoverSystemFile } from "./discovery.js";

export type SystemMdMode = "append" | "replace";

export function parseSystemMd(content: string): { mode: SystemMdMode; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { mode: "append", body: content.trim() };

  const frontmatter = match[1];
  const body = match[2].trim();
  const modeLine = frontmatter
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("mode:"));
  const mode = modeLine?.split(":")[1]?.trim().toLowerCase() === "replace" ? "replace" : "append";
  return { mode, body };
}

/** Merge `config.system.prompt` with the closest project `SYSTEM.md`, if present. */
export function resolveSystemPrompt(cwd: string, basePrompt: string): string {
  const systemFile = discoverSystemFile(cwd);
  if (!systemFile) return basePrompt;

  const { mode, body } = parseSystemMd(systemFile.content);
  if (!body) return basePrompt;
  if (mode === "replace") return body;
  return `${basePrompt.trim()}\n\n${body}`;
}
