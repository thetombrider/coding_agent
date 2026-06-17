import { describe, expect, it } from "vitest";
import { showTodoSidebar } from "./views.js";
import type { TodoItem } from "../todos/types.js";

const todos: TodoItem[] = [
  { id: "1", content: "First", status: "completed" },
  { id: "2", content: "Second", status: "in_progress" },
];

describe("showTodoSidebar", () => {
  it("shows when there are pending or in_progress tasks", () => {
    expect(showTodoSidebar(todos, "input")).toBe(true);
  });

  it("shows completed tasks while the turn is still running", () => {
    const done: TodoItem[] = [
      { id: "1", content: "First", status: "completed" },
      { id: "2", content: "Second", status: "completed" },
    ];
    expect(showTodoSidebar(done, "running")).toBe(true);
  });

  it("hides when all tasks are done and the agent is idle", () => {
    const done: TodoItem[] = [
      { id: "1", content: "First", status: "completed" },
      { id: "2", content: "Second", status: "completed" },
    ];
    expect(showTodoSidebar(done, "input")).toBe(false);
  });

  it("hides when there is no task list", () => {
    expect(showTodoSidebar([], "running")).toBe(false);
  });
});
