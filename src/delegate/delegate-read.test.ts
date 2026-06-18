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
import { createLocalWorkspace } from "../workspace/local.js";

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
});
