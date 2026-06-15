import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import {
  buildStreamProviderOptions,
  getPromptCacheStrategy,
  markPromptCacheBreakpoints,
  promptCacheProviderOptions,
  requiresExplicitCacheBreakpoints,
  supportsPromptCaching,
} from "./prompt-cache.js";

describe("getPromptCacheStrategy", () => {
  it("classifies explicit-breakpoints models", () => {
    expect(getPromptCacheStrategy("anthropic/claude-sonnet-4")).toBe(
      "explicit-breakpoints",
    );
    expect(getPromptCacheStrategy("qwen/qwen3-coder-plus")).toBe(
      "explicit-breakpoints",
    );
    expect(getPromptCacheStrategy("deepseek/deepseek-v3.2")).toBe(
      "explicit-breakpoints",
    );
    expect(getPromptCacheStrategy("google/gemini-3.5-flash")).toBe(
      "explicit-breakpoints",
    );
  });

  it("classifies implicit-only models", () => {
    expect(getPromptCacheStrategy("deepseek/deepseek-v4-flash")).toBe(
      "implicit-only",
    );
    expect(getPromptCacheStrategy("minimax/minimax-m3")).toBe("implicit-only");
    expect(getPromptCacheStrategy("moonshotai/kimi-k2.7-code")).toBe(
      "implicit-only",
    );
    expect(getPromptCacheStrategy("openai/gpt-4o")).toBe("implicit-only");
    expect(getPromptCacheStrategy("x-ai/grok-3")).toBe("implicit-only");
  });

  it("excludes unsupported models and Qwen snapshots", () => {
    expect(getPromptCacheStrategy("mistralai/mistral-large-2512")).toBe("none");
    expect(getPromptCacheStrategy("qwen/qwen3.5-plus-02-15")).toBe("none");
    expect(getPromptCacheStrategy("qwen/qwen3.5-flash-02-23")).toBe("none");
  });
});

describe("supportsPromptCaching", () => {
  it("is true for explicit and implicit models", () => {
    expect(supportsPromptCaching("anthropic/claude-sonnet-4")).toBe(true);
    expect(supportsPromptCaching("deepseek/deepseek-v4-flash")).toBe(true);
    expect(supportsPromptCaching("openrouter:minimax/minimax-m3")).toBe(true);
  });

  it("is false for unsupported models", () => {
    expect(supportsPromptCaching("mistralai/mistral-large-2512")).toBe(false);
  });
});

describe("requiresExplicitCacheBreakpoints", () => {
  it("is true only for explicit-breakpoints models", () => {
    expect(requiresExplicitCacheBreakpoints("anthropic/claude-sonnet-4")).toBe(
      true,
    );
    expect(requiresExplicitCacheBreakpoints("google/gemini-3.5-flash")).toBe(
      true,
    );
    expect(requiresExplicitCacheBreakpoints("deepseek/deepseek-v4-flash")).toBe(
      false,
    );
    expect(requiresExplicitCacheBreakpoints("minimax/minimax-m3")).toBe(false);
  });
});

describe("promptCacheProviderOptions", () => {
  it("returns cache hints for explicit-breakpoints models", () => {
    expect(promptCacheProviderOptions("anthropic/claude-sonnet-4")).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(promptCacheProviderOptions("qwen/qwen3-max")).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  it("returns undefined for implicit-only models", () => {
    expect(promptCacheProviderOptions("deepseek/deepseek-v4-flash")).toBeUndefined();
    expect(promptCacheProviderOptions("minimax/minimax-m3")).toBeUndefined();
  });
});

describe("buildStreamProviderOptions", () => {
  it("includes session_id for OpenRouter sticky routing", () => {
    expect(buildStreamProviderOptions("deepseek/deepseek-v4-flash", "sess-abc")).toEqual({
      openrouter: { session_id: "sess-abc" },
    });
  });

  it("merges cache hints and session_id for explicit models", () => {
    expect(buildStreamProviderOptions("anthropic/claude-sonnet-4", "sess-abc")).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
      openrouter: { session_id: "sess-abc" },
    });
  });

  it("truncates session ids longer than 256 characters", () => {
    const longId = "x".repeat(300);
    const opts = buildStreamProviderOptions("deepseek/deepseek-v4-flash", longId);
    expect((opts?.openrouter as { session_id: string }).session_id).toHaveLength(256);
  });

  it("returns undefined when there is nothing to attach", () => {
    expect(buildStreamProviderOptions("mistralai/mistral-large-2512")).toBeUndefined();
  });
});

describe("markPromptCacheBreakpoints", () => {
  it("marks the penultimate message for explicit-breakpoints models", () => {
    const aiMessages: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: "second" },
    ];

    markPromptCacheBreakpoints(aiMessages, "google/gemini-3.5-flash");

    expect(aiMessages[0].providerOptions).toBeUndefined();
    expect(aiMessages[1].providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(aiMessages[2].providerOptions).toBeUndefined();
  });

  it("skips marking for implicit-only models", () => {
    const aiMessages: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: "second" },
    ];

    markPromptCacheBreakpoints(aiMessages, "deepseek/deepseek-v4-flash");

    for (const message of aiMessages) {
      expect(message.providerOptions).toBeUndefined();
    }
  });

  it("does nothing for single-message conversations", () => {
    const aiMessages: ModelMessage[] = [{ role: "user", content: "only" }];

    markPromptCacheBreakpoints(aiMessages, "anthropic/claude-sonnet-4");

    expect(aiMessages[0].providerOptions).toBeUndefined();
  });
});
