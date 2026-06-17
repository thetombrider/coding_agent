import type { DiscoveredFile } from "./discovery.js";

export function formatProjectInstructions(files: DiscoveredFile[]): string {
  if (files.length === 0) return "";
  return files
    .map(
      (file) =>
        `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`,
    )
    .join("\n\n");
}
