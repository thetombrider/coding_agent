import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  DELEGATE_READ_SYSTEM,
  runDelegateRead,
  buildDelegateReadCorpus,
  buildDelegateReadMessages,
  type DelegateReadGenerate,
} from "./delegate-read.js";

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
        { task: "what secret?", paths: ["sample.txt"], cwd },
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
      { task: "hi", paths: ["missing.txt"], cwd: "/tmp" },
      mockGenerate,
    );
    expect(result.warnings[0]).toMatch(/not found/);
  });
});
