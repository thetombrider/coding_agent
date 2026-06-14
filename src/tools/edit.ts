import { createTwoFilesPatch } from "diff";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { resolvePath } from "../util/paths.js";
import { loadToolDescription } from "../util/load-txt.js";
import type { Tool } from "./types.js";

const editItemSchema = z.object({
  oldText: z.string().describe("Exact text to find (must be unique in file)"),
  newText: z.string().describe("Replacement text"),
});

const schema = z.object({
  path: z.string().describe("File to edit"),
  edits: z.array(editItemSchema).min(1).describe("Non-overlapping exact replacements"),
});

export type EditArgs = z.infer<typeof schema>;

export function applyExactEdits(original: string, edits: EditArgs["edits"]): string {
  const planned = edits.map(({ oldText, newText }) => {
    const count = original.split(oldText).length - 1;
    if (count === 0) {
      throw new Error(`oldText not found: ${JSON.stringify(oldText.slice(0, 80))}`);
    }
    if (count > 1) {
      throw new Error(`oldText must be unique but appears ${count} times`);
    }
    const start = original.indexOf(oldText);
    return { start, end: start + oldText.length, newText };
  });

  for (let i = 0; i < planned.length; i++) {
    for (let j = i + 1; j < planned.length; j++) {
      const a = planned[i]!;
      const b = planned[j]!;
      if (a.start < b.end && b.start < a.end) {
        throw new Error("edits overlap");
      }
    }
  }

  planned.sort((a, b) => b.start - a.start);
  let content = original;
  for (const { start, end, newText } of planned) {
    content = content.slice(0, start) + newText + content.slice(end);
  }
  return content;
}

export const editTool: Tool<EditArgs> = {
  name: "edit",
  description: loadToolDescription("edit"),
  schema,
  needsApproval: () => true,
  async execute({ path, edits }, ctx) {
    const fullPath = resolvePath(ctx.cwd, path);
    const original = await readFile(fullPath, "utf8");
    const updated = applyExactEdits(original, edits);
    const patch = createTwoFilesPatch(path, path, original, updated, "", "");
    await writeFile(fullPath, updated, "utf8");
    return { output: patch || `Updated ${path} (${edits.length} edit(s))` };
  },
};
