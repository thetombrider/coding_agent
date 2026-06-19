import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { Message } from "../types.js";
import {
  countCompletedTodos,
  formatRemindersBlock,
  hasActiveTodos,
  rebuildTodosFromMessages,
  writeTodoExport,
} from "./store.js";
import type { TodoItem } from "./types.js";

const todos: TodoItem[] = [
  { id: "1", content: "Step one", status: "completed" },
  { id: "2", content: "Step two", status: "in_progress" },
  { id: "3", content: "Step three", status: "pending" },
];

describe("todo store", () => {
  it("formats a REMINDERS block with progress", () => {
    const block = formatRemindersBlock(todos);
    expect(block).toContain("REMINDERS");
    expect(block).toContain("Task progress: 1/3");
    expect(block).toContain("Step two (in_progress)");
  });

  it("counts completed and cancelled items", () => {
    expect(countCompletedTodos(todos)).toBe(1);
    expect(
      countCompletedTodos([
        ...todos,
        { id: "4", content: "Skipped", status: "cancelled" },
      ]),
    ).toBe(2);
  });

  it("detects active todos", () => {
    expect(hasActiveTodos(todos)).toBe(true);
    expect(
      hasActiveTodos([
        { id: "1", content: "Done", status: "completed" },
        { id: "2", content: "Skipped", status: "cancelled" },
      ]),
    ).toBe(false);
  });

  it("rebuilds todos from the last todowrite tool call", () => {
    const first: Message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc1",
          name: "todowrite",
          arguments: {
            todos: [{ id: "a", content: "Old plan", status: "pending" }],
          },
        },
      ],
    };
    const second: Message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc2",
          name: "todowrite",
          arguments: { todos },
        },
      ],
    };

    expect(rebuildTodosFromMessages([first, second])).toEqual(todos);
  });

  it("returns an empty list when no todowrite calls exist", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
      },
    ];
    expect(rebuildTodosFromMessages(messages)).toEqual([]);
  });

  it("writes optional .orin/todo.md export", () => {
    const cwd = mkdtempSync(join(tmpdir(), "todo-export-"));
    try {
      writeTodoExport(cwd, todos);
      const exported = readFileSync(join(cwd, ".orin", "todo.md"), "utf8");
      expect(exported).toContain("Step two");
      expect(exported).toContain("Progress: 1/3");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
