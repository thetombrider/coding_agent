import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { resolvePath } from "../util/paths.js";
import { loadToolDescription } from "../util/load-txt.js";
import { EditMismatchError, findMatch } from "../edit/replacers.js";
import { formatEditMismatchError } from "../provider/tool-call-parser.js";
import type { Tool } from "./types.js";

const editItemSchema = z.object({
  oldText: z.string().describe("Text to find (must be unique in file, or use startLine to disambiguate)"),
  newText: z.string().describe("Replacement text"),
  startLine: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1-indexed line hint — disambiguates non-unique oldText (also accepts :start_line:N prefix)"),
});

const schema = z.object({
  path: z.string().describe("File to edit"),
  edits: z.array(editItemSchema).min(1).describe("Non-overlapping replacements"),
});

export type EditArgs = z.infer<typeof schema>;

type PlannedEdit = { start: number; end: number; newText: string };

export function applyExactEdits(original: string, edits: EditArgs["edits"]): string {
  return applyFuzzyEdits(original, edits);
}

export function applyFuzzyEdits(original: string, edits: EditArgs["edits"]): string {
  if (edits.some((e) => !e.oldText)) throw new Error("oldText must be non-empty");

  const planned: PlannedEdit[] = edits.map(({ oldText, newText, startLine }) => ({
    ...findMatch(original, oldText, { startLine }),
    newText,
  }));

  for (let i = 0; i < planned.length; i++) {
    for (let j = i + 1; j < planned.length; j++) {
      const a = planned[i]!;
      const b = planned[j]!;
      if (a.start < b.end && b.start < a.end) throw new Error("edits overlap");
    }
  }

  // Sort ascending and apply with a running delta so out-of-order blocks land correctly.
  planned.sort((a, b) => a.start - b.start);
  let content = original;
  let delta = 0;
  for (const { start, end, newText } of planned) {
    const adjStart = start + delta;
    const adjEnd = end + delta;
    content = content.slice(0, adjStart) + newText + content.slice(adjEnd);
    delta += newText.length - (end - start);
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
    const original = await ctx.workspace.readFile(fullPath);
    try {
      const updated = applyExactEdits(original, edits);
      const patch = createTwoFilesPatch(path, path, original, updated, "", "");
      await ctx.workspace.writeFile(fullPath, updated);
      return { output: patch || `Updated ${path} (${edits.length} edit(s))` };
    } catch (err) {
      if (err instanceof EditMismatchError) {
        return { output: formatEditMismatchError(err.details), isError: true };
      }
      throw err;
    }
  },
};
