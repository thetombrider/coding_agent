import { describe, expect, it } from "vitest";
import { replayLog } from "../session/log.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "../types.js";
import { messagesToTurns } from "./messages-to-turns.js";

describe("messagesToTurns", () => {
  it("rebuilds a turn with tool call and result", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "read package.json" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "package.json" } }],
      },
      {
        role: "tool",
        content: [{ type: "toolResult", toolCallId: "tc1", output: '{"name":"orin"}', isError: false }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "It defines the orin package." }],
      },
    ];

    const turns = messagesToTurns(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.userText).toBe("read package.json");
    expect(turns[0]?.assistantText).toBe("It defines the orin package.");
    expect(turns[0]?.tools).toEqual([
      {
        id: "tc1",
        name: "read",
        args: { path: "package.json" },
        status: "done",
        output: '{"name":"orin"}',
      },
    ]);
  });

  it("accumulates multiple tools and assistant text across loop rounds", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "inspect repo" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking " },
          { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "toolResult", toolCallId: "tc1", output: "src\npackage.json", isError: false }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Now reading " },
          { type: "toolCall", id: "tc2", name: "read", arguments: { path: "README.md" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "toolResult", toolCallId: "tc2", output: "# Orin", isError: false }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
      },
    ];

    const turns = messagesToTurns(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.assistantText).toBe("Checking Now reading Done.");
    expect(turns[0]?.tools).toHaveLength(2);
    expect(turns[0]?.tools[0]).toMatchObject({ id: "tc1", name: "bash", status: "done" });
    expect(turns[0]?.tools[1]).toMatchObject({ id: "tc2", name: "read", status: "done", output: "# Orin" });
  });

  it("marks failed tools as error and preserves output for edit diffs", () => {
    const patch = "@@ -1 +1 @@\n-old\n+new";
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "edit file" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "edit", arguments: { path: "foo.ts" } }],
      },
      {
        role: "tool",
        content: [{ type: "toolResult", toolCallId: "tc1", output: patch, isError: false }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Updated." }],
      },
      { role: "user", content: [{ type: "text", text: "run missing tool" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc2", name: "bash", arguments: { command: "false" } }],
      },
      {
        role: "tool",
        content: [{ type: "toolResult", toolCallId: "tc2", output: "command failed", isError: true }],
      },
    ];

    const turns = messagesToTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.tools[0]).toMatchObject({ name: "edit", status: "done", output: patch });
    expect(turns[1]?.tools[0]).toMatchObject({ name: "bash", status: "error", output: "command failed" });
  });

  it("deduplicates tool calls with the same id across assistant chunks", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
      },
      {
        role: "tool",
        content: [{ type: "toolResult", toolCallId: "tc1", output: "ok", isError: false }],
      },
    ];

    const turns = messagesToTurns(messages);
    expect(turns[0]?.tools).toHaveLength(1);
    expect(turns[0]?.tools[0]?.output).toBe("ok");
  });

  it("leaves tool rows without results as done with no output", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "start" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "sleep 99" } }],
      },
    ];

    const turns = messagesToTurns(messages);
    expect(turns[0]?.tools).toEqual([
      { id: "tc1", name: "bash", args: { command: "sleep 99" }, status: "done" },
    ]);
  });

  it("round-trips replayLog fixture with tool calls", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ca-turns-test-"));
    try {
      const path = join(tmpDir, "session.jsonl");
      writeFileSync(
        path,
        [
          JSON.stringify({
            type: "user_message",
            ts: "t1",
            content: [{ type: "text", text: "grep for TODO" }],
          }),
          JSON.stringify({
            type: "assistant_chunk",
            ts: "t2",
            content: [{ type: "toolCall", id: "tc1", name: "grep", arguments: { pattern: "TODO" } }],
          }),
          JSON.stringify({
            type: "tool_result",
            ts: "t3",
            toolUseId: "tc1",
            content: [{ type: "toolResult", toolCallId: "tc1", output: "src/foo.ts:1:TODO fix", isError: false }],
          }),
          JSON.stringify({
            type: "assistant_chunk",
            ts: "t4",
            content: [{ type: "text", text: "Found one match." }],
          }),
        ].join("\n") + "\n",
      );

      const turns = messagesToTurns(replayLog(path));
      expect(turns).toHaveLength(1);
      expect(turns[0]?.tools[0]).toMatchObject({
        name: "grep",
        status: "done",
        output: "src/foo.ts:1:TODO fix",
      });
      expect(turns[0]?.assistantText).toBe("Found one match.");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
