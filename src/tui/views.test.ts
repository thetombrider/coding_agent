import { describe, expect, it } from "vitest";
import {
  costBadge,
  formatCostUsd,
  formatModelPricingLabel,
  formatSessionCost,
  formatTokenCount,
  showTodoSidebar,
} from "./views.js";
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

describe("cost formatting", () => {
  it("formats sub-dollar costs with more precision", () => {
    expect(formatCostUsd(0.042)).toBe("$0.042");
    expect(formatCostUsd(1.5)).toBe("$1.50");
  });

  it("formats token counts compactly", () => {
    expect(formatTokenCount(512)).toBe("512");
    expect(formatTokenCount(12_300)).toBe("12.3k");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
  });

  it("renders a per-session cost label, falling back to a dash", () => {
    expect(formatSessionCost(0.04)).toBe("$0.040");
    expect(formatSessionCost(null)).toBe("—");
    expect(formatSessionCost(undefined)).toBe("—");
  });

  it("formats model pricing labels for the picker", () => {
    expect(formatModelPricingLabel({ inputPerM: 3, outputPerM: 15 })).toBe("in $3.00 · out $15.00/M");
    expect(formatModelPricingLabel({ inputPerM: 0.14, outputPerM: 0.28 })).toBe("in $0.14 · out $0.28/M");
    expect(formatModelPricingLabel(undefined)).toBe("—");
  });
});

describe("costBadge", () => {
  it("shows the dollar amount when pricing is known", () => {
    expect(costBadge({ costUsd: 0.042, tokenTotals: 1000 })).toBe("· $0.042");
  });

  it("falls back to a token count when pricing is unknown", () => {
    expect(costBadge({ costUsd: null, tokenTotals: 12_300 })).toBe("· 12.3k tok");
  });

  it("shows $0.00 under --faux regardless of cost", () => {
    expect(costBadge({ costUsd: 5, tokenTotals: 999, faux: true })).toBe("· $0.00");
  });

  it("is empty before the first turn lands", () => {
    expect(costBadge({ costUsd: null, tokenTotals: 0 })).toBe("");
    expect(costBadge({})).toBe("");
  });
});
