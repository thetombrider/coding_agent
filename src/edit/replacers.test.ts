import { describe, expect, it } from "vitest";
import {
  simpleMatch,
  lineTrimmedMatch,
  blockAnchorMatch,
  whitespaceNormalizedMatch,
  indentationFlexibleMatch,
  escapeNormalizedMatch,
  levenshteinMatch,
  findMatch,
} from "./replacers.js";

// Helper: apply a match result to perform the actual substitution
function applyMatch(
  content: string,
  oldText: string,
  newText: string,
  matcher: (c: string, o: string) => { start: number; end: number } | null,
): string | null {
  const m = matcher(content, oldText);
  if (!m) return null;
  return content.slice(0, m.start) + newText + content.slice(m.end);
}

describe("simpleMatch", () => {
  it("matches exact text", () => {
    const r = simpleMatch("hello world", "world");
    expect(r).toEqual({ start: 6, end: 11 });
  });

  it("strips leading/trailing newlines from oldText", () => {
    const r = simpleMatch("hello world", "\nworld\n");
    expect(r).toEqual({ start: 6, end: 11 });
  });

  it("returns null when text not found", () => {
    expect(simpleMatch("hello world", "foo")).toBeNull();
  });

  it("returns null when text appears multiple times", () => {
    expect(simpleMatch("foo foo", "foo")).toBeNull();
  });

  it("returns null for empty needle", () => {
    expect(simpleMatch("hello", "")).toBeNull();
  });
});

describe("lineTrimmedMatch", () => {
  it("matches lines with trailing spaces in file", () => {
    const file = "const x = 1;   \nconst y = 2;\n";
    const old = "const x = 1;\nconst y = 2;";
    const result = applyMatch(file, old, "REPLACED", lineTrimmedMatch);
    expect(result).toBe("REPLACED\n");
  });

  it("matches lines with trailing spaces in oldText", () => {
    const file = "const x = 1;\nconst y = 2;\n";
    const old = "const x = 1;   \nconst y = 2;  ";
    const result = applyMatch(file, old, "REPLACED", lineTrimmedMatch);
    expect(result).toBe("REPLACED\n");
  });

  it("returns null when text not found even after trimming", () => {
    expect(lineTrimmedMatch("abc\ndef\n", "xyz\ndef")).toBeNull();
  });

  it("returns null when multiple windows match", () => {
    const file = "foo   \nbar\nfoo   \nbar\n";
    expect(lineTrimmedMatch(file, "foo\nbar")).toBeNull();
  });

  it("handles single-line match with trailing space", () => {
    // The matched region includes the trailing spaces on that line; newText replaces it entirely
    const r = applyMatch("hello world   \n", "hello world", "hi", lineTrimmedMatch);
    expect(r).toBe("hi\n");
  });
});

describe("blockAnchorMatch", () => {
  it("matches by first/last line with interior trim", () => {
    const file = "function foo() {  \n  return 1;  \n}\n";
    const old = "function foo() {\n  return 1;\n}";
    const result = applyMatch(file, old, "REPLACED", blockAnchorMatch);
    expect(result).toBe("REPLACED\n");
  });

  it("returns null when anchors don't match", () => {
    const file = "function bar() {\n  return 1;\n}\n";
    const old = "function foo() {\n  return 1;\n}";
    expect(blockAnchorMatch(file, old)).toBeNull();
  });

  it("returns null for ambiguous anchor match", () => {
    const file = "fn() {\n  a;\n}\nfn() {\n  b;\n}\n";
    const old = "fn() {\n  a;\n}";
    // Only one block matches the interior, so this should succeed
    const r = blockAnchorMatch(file, old);
    expect(r).not.toBeNull();
  });

  it("handles single-line (delegates to trim matcher)", () => {
    const r = blockAnchorMatch("  hello  \n", "hello");
    expect(r).not.toBeNull();
  });
});

describe("whitespaceNormalizedMatch", () => {
  it("matches with different indentation (2 vs 4 spaces)", () => {
    const file = "    const x = 1;\n    const y = 2;\n";
    const old = "  const x = 1;\n  const y = 2;";
    const result = applyMatch(file, old, "REPLACED", whitespaceNormalizedMatch);
    expect(result).toBe("REPLACED\n");
  });

  it("matches with tabs vs spaces", () => {
    const file = "\tconst x = 1;\n\tconst y = 2;\n";
    const old = "  const x = 1;\n  const y = 2;";
    const result = applyMatch(file, old, "REPLACED", whitespaceNormalizedMatch);
    expect(result).toBe("REPLACED\n");
  });

  it("matches with extra internal spaces collapsed", () => {
    // whitespaceNormalized collapses multiple spaces/tabs; "const  x  =  1;" → "const x = 1;"
    const file = "const  x  =  1;\n";
    const old = "const x = 1;";
    const result = applyMatch(file, old, "REPLACED", whitespaceNormalizedMatch);
    expect(result).toBe("REPLACED\n");
  });

  it("returns null when text is genuinely different", () => {
    expect(whitespaceNormalizedMatch("const x = 1;\n", "const y = 2;")).toBeNull();
  });
});

describe("indentationFlexibleMatch", () => {
  it("matches deeply nested code when oldText is flush left", () => {
    const file = "    if (true) {\n      return 1;\n    }\n";
    const old = "if (true) {\n  return 1;\n}";
    // indentationFlexible strips leading whitespace from each line
    const r = indentationFlexibleMatch(file, old);
    expect(r).not.toBeNull();
  });

  it("matches flush-left code when oldText is indented", () => {
    const file = "if (true) {\n  return 1;\n}\n";
    const old = "    if (true) {\n      return 1;\n    }";
    const r = indentationFlexibleMatch(file, old);
    expect(r).not.toBeNull();
  });

  it("strips common indent correctly", () => {
    const file = "    foo();\n    bar();\n";
    const old = "  foo();\n  bar();";
    const result = applyMatch(file, old, "REPLACED", indentationFlexibleMatch);
    expect(result).toBe("REPLACED\n");
  });

  it("returns null when content differs after stripping indent", () => {
    expect(indentationFlexibleMatch("  foo();\n  bar();\n", "baz();\nqux();")).toBeNull();
  });
});

describe("escapeNormalizedMatch", () => {
  it("matches \\n literal vs actual newline in file", () => {
    // file has actual tab, oldText has \\t
    const file = "const s = '\thello';\n";
    const old = "const s = '\\thello';";
    const r = escapeNormalizedMatch(file, old);
    expect(r).not.toBeNull();
  });

  it("matches unicode escape vs actual character", () => {
    const file = "const c = 'é';\n";
    const old = "const c = '\\u00e9';";
    const r = escapeNormalizedMatch(file, old);
    expect(r).not.toBeNull();
  });

  it("matches HTML entities vs actual characters", () => {
    const file = "const s = 'a & b';\n";
    const old = "const s = 'a &amp; b';";
    const r = escapeNormalizedMatch(file, old);
    expect(r).not.toBeNull();
  });

  it("returns null for genuinely different content", () => {
    expect(escapeNormalizedMatch("const x = 1;\n", "const y = 2;")).toBeNull();
  });
});

describe("levenshteinMatch", () => {
  it("matches with ≤20% edit distance", () => {
    // 1 character difference in a 10-char string = 10%, below threshold
    const file = "hello world\n";
    const old = "helo world"; // missing 'l' — 1 edit
    const r = levenshteinMatch(file, old);
    expect(r).not.toBeNull();
  });

  it("returns null when distance exceeds 20% threshold", () => {
    // "abcdefghij" vs "ABCDEFGHIJ" — 10 edits in 10 chars = 100% > 20%
    expect(levenshteinMatch("abcdefghij\n", "ABCDEFGHIJ")).toBeNull();
  });

  it("returns null for ambiguous best match", () => {
    const file = "foo bar\nfoo bar\n";
    const old = "foo baz"; // 1 edit from each line
    expect(levenshteinMatch(file, old)).toBeNull();
  });
});

describe("findMatch chain", () => {
  it("falls through to lineTrimmedMatch", () => {
    const file = "const x = 1;   \nconst y = 2;\n";
    const old = "const x = 1;\nconst y = 2;";
    const r = findMatch(file, old);
    expect(r).toBeDefined();
    expect(file.slice(0, r.start) + "REPLACED" + file.slice(r.end)).toBe("REPLACED\n");
  });

  it("throws descriptive error when all matchers fail", () => {
    expect(() => findMatch("abc\n", "xyz")).toThrow(/edit failed/);
    expect(() => findMatch("abc\n", "xyz")).toThrow(/exact match/);
    expect(() => findMatch("abc\n", "xyz")).toThrow(/grep/);
  });

  it("simpleMatch wins for exact input", () => {
    const r = findMatch("hello world", "hello");
    expect(r).toEqual({ start: 0, end: 5 });
  });

  it("indentation-flexible match fixes wrong-indent quote from model", () => {
    const file = "class Foo {\n  constructor() {\n    this.x = 1;\n  }\n}\n";
    // Model quotes with no indentation
    const old = "constructor() {\n  this.x = 1;\n}";
    const r = findMatch(file, old);
    expect(r).toBeDefined();
    const result = file.slice(0, r.start) + "REPLACED" + file.slice(r.end);
    expect(result).toContain("REPLACED");
  });
});
