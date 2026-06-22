import { describe, expect, it } from "vitest";
import { formatProjectInstructions } from "./instructions.js";

describe("formatProjectInstructions", () => {
  it("returns an empty string with no files", () => {
    expect(formatProjectInstructions([])).toBe("");
  });

  it("wraps a single file in a project_instructions tag with its path", () => {
    const result = formatProjectInstructions([
      { path: "/repo/AGENTS.md", content: "be concise" },
    ]);
    expect(result).toBe(
      '<project_instructions path="/repo/AGENTS.md">\nbe concise\n</project_instructions>',
    );
  });

  it("joins multiple files with a blank line between blocks", () => {
    const result = formatProjectInstructions([
      { path: "a.md", content: "one" },
      { path: "b.md", content: "two" },
    ]);
    expect(result).toBe(
      '<project_instructions path="a.md">\none\n</project_instructions>\n\n' +
        '<project_instructions path="b.md">\ntwo\n</project_instructions>',
    );
  });

  it("preserves multi-line content verbatim", () => {
    const result = formatProjectInstructions([
      { path: "x.md", content: "line1\nline2" },
    ]);
    expect(result).toContain("line1\nline2");
  });
});
