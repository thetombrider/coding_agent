import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  DELEGATE_READ_SYSTEM,
  runDelegateRead,
  buildDelegateReadCorpus,
  buildDelegateReadMessages,
  extractFileRanges,
  selectFileContents,
  type DelegateReadGenerate,
} from "./delegate-read.js";
import { createLocalWorkspace } from "../workspace/local.js";
import type { SymbolService } from "../symbols/service.js";
import type { Symbol as IndexSymbol } from "../symbols/types.js";

function makeSymbolService(opts: {
  ready: boolean;
  symbols?: IndexSymbol[];
}): SymbolService {
  const syms = opts.symbols ?? [];
  return {
    get ready() { return opts.ready; },
    warmIndex: async () => ({ files: 0, symbols: 0, references: 0, elapsedMs: 0 }),
    reindexFile: async () => {},
    removeFile: () => {},
    query: () => ({ symbols: [], references: [] }),
    allSymbols: () => syms,
  };
}

describe("runDelegateRead", () => {
  it("builds corpus and messages for the cheap model", () => {
    const corpus = buildDelegateReadCorpus(["a.ts"], new Map([["a.ts", "hello"]]));
    expect(corpus).toContain("<file path='a.ts'>");
    expect(corpus).toContain("hello");

    const messages = buildDelegateReadMessages(corpus, "what is in a.ts?");
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toContain("<corpus>");
    expect(messages[1]?.content).toBe("what is in a.ts?");
  });

  it("calls cheap model with file contents", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "delegate-read-"));
    try {
      await writeFile(join(cwd, "sample.txt"), "secret=42\n", "utf8");

      const calls: unknown[] = [];
      const mockGenerate: DelegateReadGenerate = async (opts) => {
        calls.push(opts);
        return { text: "The file sets secret to 42." };
      };

      const result = await runDelegateRead(
        { task: "what secret?", paths: ["sample.txt"], cwd, workspace: createLocalWorkspace() },
        mockGenerate,
      );

      expect(result.answer).toContain("42");
      expect(result.warnings).toEqual([]);
      expect(calls[0]).toMatchObject({
        system: DELEGATE_READ_SYSTEM,
        maxOutputTokens: 8192,
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("warns on missing paths", async () => {
    const mockGenerate: DelegateReadGenerate = async () => ({ text: "ok" });
    const result = await runDelegateRead(
      { task: "hi", paths: ["missing.txt"], cwd: "/tmp", workspace: createLocalWorkspace() },
      mockGenerate,
    );
    expect(result.warnings[0]).toMatch(/not found/);
  });

  it("records the cheap-model call with delegate_read source and tokens", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "delegate-read-"));
    try {
      await writeFile(join(cwd, "sample.txt"), "secret=42\n", "utf8");

      const mockGenerate: DelegateReadGenerate = async () => ({
        text: "ok",
        usage: { inputTokens: 200, outputTokens: 40, totalTokens: 240 },
      });

      const calls: Array<{ model: string; usage: unknown; source: string }> = [];
      await runDelegateRead(
        {
          task: "what secret?",
          paths: ["sample.txt"],
          cwd,
          workspace: createLocalWorkspace(),
          model: "cheap:test",
          record: (call) => calls.push(call),
        },
        mockGenerate,
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]?.source).toBe("delegate_read");
      expect(calls[0]?.model).toBe("cheap:test");
      expect(calls[0]?.usage).toMatchObject({ input: 200, output: 40, totalTokens: 240 });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("skips recording when the generate result has no usage", async () => {
    const mockGenerate: DelegateReadGenerate = async () => ({ text: "ok" });
    const calls: unknown[] = [];
    await runDelegateRead(
      {
        task: "hi",
        cwd: "/tmp",
        workspace: createLocalWorkspace(),
        record: (call) => calls.push(call),
      },
      mockGenerate,
    );
    expect(calls).toHaveLength(0);
  });

  it("uses symbol index to send only relevant ranges to cheap model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "delegate-read-symbols-"));
    try {
      const content = Array.from({ length: 50 }, (_, i) => `// line ${i + 1}`).join("\n");
      await writeFile(join(cwd, "big.ts"), content, "utf8");

      const svc = makeSymbolService({
        ready: true,
        symbols: [
          {
            id: "1",
            name: "targetFunction",
            kind: "function",
            file: "big.ts",
            startLine: 20,
            endLine: 25,
          },
        ],
      });

      let capturedCorpus = "";
      const mockGenerate: DelegateReadGenerate = async (opts) => {
        capturedCorpus = opts.messages[0]?.content ?? "";
        return { text: "found it" };
      };

      await runDelegateRead(
        {
          task: "what does targetFunction do?",
          paths: ["big.ts"],
          cwd,
          workspace: createLocalWorkspace(),
          symbols: svc,
        },
        mockGenerate,
      );

      expect(capturedCorpus).toContain("[lines");
      // Full file would have line 1 through line 50 in sequence; ranges omit early lines
      expect(capturedCorpus).not.toContain("// line 1\n// line 2\n// line 3");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to full file content when symbol index is not ready", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "delegate-read-symbols-fallback-"));
    try {
      await writeFile(join(cwd, "sample.ts"), "line 1\nline 2\nline 3\n", "utf8");

      const svc = makeSymbolService({ ready: false });
      let capturedCorpus = "";
      const mockGenerate: DelegateReadGenerate = async (opts) => {
        capturedCorpus = opts.messages[0]?.content ?? "";
        return { text: "ok" };
      };

      await runDelegateRead(
        {
          task: "what is targetFunction?",
          paths: ["sample.ts"],
          cwd,
          workspace: createLocalWorkspace(),
          symbols: svc,
        },
        mockGenerate,
      );

      expect(capturedCorpus).toContain("line 1\nline 2\nline 3");
      expect(capturedCorpus).not.toContain("[lines");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("extractFileRanges", () => {
  it("extracts a single range with padding", () => {
    const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = extractFileRanges(content, [{ start: 10, end: 12 }], 3);
    expect(result).toContain("[lines 7-15]");
    expect(result).toContain("line 7");
    expect(result).toContain("line 15");
    expect(result).not.toContain("line 6");
    expect(result).not.toContain("line 16");
  });

  it("merges overlapping ranges into one", () => {
    const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = extractFileRanges(content, [{ start: 5, end: 8 }, { start: 7, end: 12 }], 0);
    expect(result).toContain("[lines 5-12]");
    expect(result.match(/\[lines/g)).toHaveLength(1);
  });

  it("clamps range start to line 1 when padding exceeds file start", () => {
    const content = "line 1\nline 2\nline 3";
    const result = extractFileRanges(content, [{ start: 1, end: 2 }], 10);
    expect(result).toContain("[lines 1-3]");
    expect(result).not.toMatch(/line 0/);
  });

  it("clamps range end to last line when padding exceeds file end", () => {
    const content = "line 1\nline 2\nline 3";
    const result = extractFileRanges(content, [{ start: 2, end: 3 }], 10);
    expect(result).toContain("[lines 1-3]");
  });
});

describe("selectFileContents", () => {
  it("returns original map when index is not ready", () => {
    const contents = new Map([["foo.ts", "line1\nline2\nline3"]]);
    const svc = makeSymbolService({ ready: false });
    const result = selectFileContents("find runFoo", ["foo.ts"], contents, svc);
    expect(result).toBe(contents);
  });

  it("returns original map when no task terms are long enough", () => {
    const contents = new Map([["foo.ts", "line1\nline2\nline3"]]);
    const svc = makeSymbolService({ ready: true, symbols: [] });
    // all words are < 4 chars
    const result = selectFileContents("hi do x", ["foo.ts"], contents, svc);
    expect(result).toBe(contents);
  });

  it("extracts matching ranges for files with symbol hits", () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const contents = new Map([["foo.ts", content]]);
    const svc = makeSymbolService({
      ready: true,
      symbols: [
        { id: "1", name: "myFunction", kind: "function", file: "foo.ts", startLine: 8, endLine: 10 },
      ],
    });
    const result = selectFileContents("find myFunction details", ["foo.ts"], contents, svc);
    const selected = result.get("foo.ts")!;
    expect(selected).toContain("[lines");
    expect(selected).not.toBe(content);
  });

  it("falls back to full content for files with no matching symbols", () => {
    const content = "line1\nline2\nline3";
    const contents = new Map([["bar.ts", content]]);
    const svc = makeSymbolService({
      ready: true,
      symbols: [
        { id: "1", name: "myFunction", kind: "function", file: "other.ts", startLine: 1, endLine: 5 },
      ],
    });
    const result = selectFileContents("find myFunction things", ["bar.ts"], contents, svc);
    expect(result.get("bar.ts")).toBe(content);
  });

  it("handles multiple files independently — some trimmed, some full", () => {
    const contA = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const contB = "b line 1\nb line 2";
    const contents = new Map([["a.ts", contA], ["b.ts", contB]]);
    const svc = makeSymbolService({
      ready: true,
      symbols: [
        { id: "1", name: "myFunction", kind: "function", file: "a.ts", startLine: 10, endLine: 12 },
      ],
    });
    const result = selectFileContents("find myFunction usage", ["a.ts", "b.ts"], contents, svc);
    expect(result.get("a.ts")).toContain("[lines");
    expect(result.get("b.ts")).toBe(contB);
  });
});
