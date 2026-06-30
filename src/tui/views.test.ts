import { describe, expect, it } from "vitest";
import {
  contextBadge,
  costBadge,
  formatContextWindowLabel,
  formatCostUsd,
  formatModelPricingLabel,
  formatSessionCost,
  formatTokenCount,
  showTodoSidebar,
  shouldWrapToolSummary,
  toolSummary,
  wrapLineCount,
  TOOL_SUMMARY_INLINE_MAX,
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

  it("formats context window labels compactly for the picker", () => {
    expect(formatContextWindowLabel(200_000)).toBe("200k ctx");
    expect(formatContextWindowLabel(128_000)).toBe("128k ctx");
    expect(formatContextWindowLabel(1_000_000)).toBe("1M ctx");
    expect(formatContextWindowLabel(1_048_576)).toBe("1M ctx");
    expect(formatContextWindowLabel(512)).toBe("512 ctx");
  });

  it("omits the context label when the window is unknown", () => {
    expect(formatContextWindowLabel(undefined)).toBe("");
    expect(formatContextWindowLabel(0)).toBe("");
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

describe("contextBadge", () => {
  it("shows the rounded percentage of the window used", () => {
    expect(contextBadge({ contextTokens: 50_000, contextWindow: 200_000 })).toBe("· 25% ctx");
    expect(contextBadge({ contextTokens: 33_333, contextWindow: 100_000 })).toBe("· 33% ctx");
  });

  it("caps at 100% when the context overflows the window", () => {
    expect(contextBadge({ contextTokens: 250_000, contextWindow: 200_000 })).toBe("· 100% ctx");
  });

  it("is empty until both the reading and the window are known", () => {
    expect(contextBadge({ contextWindow: 200_000 })).toBe("");
    expect(contextBadge({ contextTokens: 50_000 })).toBe("");
    expect(contextBadge({ contextTokens: 0, contextWindow: 200_000 })).toBe("");
    expect(contextBadge({ contextTokens: 50_000, contextWindow: 0 })).toBe("");
    expect(contextBadge({})).toBe("");
  });
});

describe("toolSummary", () => {
  const longCommand = "cd /Users/tommy/coding/coding_agent && gh issue view 222 && bun test";

  it("truncates long bash commands by default", () => {
    const summary = toolSummary("bash", { command: longCommand });
    expect(summary).toMatch(/…$/);
    expect(summary.length).toBeLessThan(longCommand.length);
  });

  it("shows the full command when truncation is disabled", () => {
    expect(toolSummary("bash", { command: longCommand }, { truncate: false })).toBe(longCommand);
  });

  it("leaves short commands unchanged", () => {
    expect(toolSummary("bash", { command: "echo hi" })).toBe("echo hi");
  });
});

describe("toolSummary — skill tools", () => {
  it("shows skill name for skill_use", () => {
    expect(toolSummary("skill_use", { name: "git-workflow" })).toBe("git-workflow");
  });

  it("appends the file path for skill_use with a file", () => {
    expect(toolSummary("skill_use", { name: "git-workflow", file: "references/api.md" })).toBe(
      "git-workflow / references/api.md",
    );
  });

  it("returns empty string for skill_list", () => {
    expect(toolSummary("skill_list", {})).toBe("");
  });

  it("shows action and name for skill_write", () => {
    expect(toolSummary("skill_write", { action: "create", name: "git-workflow" })).toBe(
      "create git-workflow",
    );
  });

  it("includes scope for skill_write when present", () => {
    expect(toolSummary("skill_write", { action: "create", name: "git-workflow", scope: "global" })).toBe(
      "create git-workflow (global)",
    );
  });

  it("truncates long skill_use names", () => {
    const long = "a".repeat(80);
    const summary = toolSummary("skill_use", { name: long });
    expect(summary).toMatch(/…$/);
  });
});

describe("shouldWrapToolSummary", () => {
  it("keeps short summaries on the header row", () => {
    expect(shouldWrapToolSummary("src/hooks/registry.ts")).toBe(false);
    expect(shouldWrapToolSummary("hook")).toBe(false);
  });

  it("wraps summaries longer than the inline budget", () => {
    const long = "x".repeat(TOOL_SUMMARY_INLINE_MAX + 1);
    expect(shouldWrapToolSummary(long)).toBe(true);
    expect(shouldWrapToolSummary("x".repeat(TOOL_SUMMARY_INLINE_MAX))).toBe(false);
  });
});

describe("wrapLineCount", () => {
  it("fits a short prompt on one row", () => {
    expect(wrapLineCount("allow bash?  ls -la  —  y / n", 71)).toBe(1);
  });

  it("wraps a long single token char-by-char across many rows", () => {
    // A 760-char token with no spaces wraps one width-chunk per row.
    expect(wrapLineCount("x".repeat(760), 56)).toBe(Math.ceil(760 / 56));
  });

  it("packs words with single separating spaces until the row is full", () => {
    // 11 words of 5 chars + 10 spaces = 65 chars fits in exactly one 65-wide row.
    expect(wrapLineCount(Array.from({ length: 11 }, () => "word.").join(" "), 65)).toBe(1);
    // One column narrower and the last word wraps to a second row.
    expect(wrapLineCount(Array.from({ length: 11 }, () => "word.").join(" "), 64)).toBe(2);
  });

  it("handles degenerate widths without throwing", () => {
    expect(wrapLineCount("anything", 0)).toBe(1);
    expect(wrapLineCount("", 40)).toBe(1);
    expect(wrapLineCount("   ", 40)).toBe(1);
  });
});
