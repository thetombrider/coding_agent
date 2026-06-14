import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "./markdown-parse.js";

describe("parseInline", () => {
  it("parses bold, italic, and code", () => {
    expect(parseInline("**bold** and `code`")).toEqual([
      { kind: "bold", value: "bold" },
      { kind: "text", value: " and " },
      { kind: "code", value: "code" },
    ]);
  });
});

describe("parseBlocks", () => {
  it("parses headings and fenced code", () => {
    const blocks = parseBlocks("## Title\n\n```ts\nconst x = 1\n```");
    expect(blocks[0]).toEqual({ type: "heading", level: 2, text: "Title" });
    expect(blocks[1]).toMatchObject({ type: "code", lang: "ts", body: "const x = 1" });
  });

  it("parses bullet lists", () => {
    const blocks = parseBlocks("- one\n- two");
    expect(blocks[0]).toEqual({
      type: "list",
      ordered: false,
      items: ["one", "two"],
    });
  });

  it("parses markdown tables", () => {
    const source = [
      "| Folder | Purpose |",
      "|--------|---------|",
      "| src/ | Source code |",
      "| dist/ | Compiled `tsc` output |",
    ].join("\n");
    const blocks = parseBlocks(source);
    expect(blocks[0]).toEqual({
      type: "table",
      headers: ["Folder", "Purpose"],
      rows: [
        ["src/", "Source code"],
        ["dist/", "Compiled `tsc` output"],
      ],
    });
  });
});
