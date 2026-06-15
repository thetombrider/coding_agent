import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import {
  markPromptCacheBreakpoints,
  promptCacheProviderOptions,
  supportsPromptCaching,
} from "./prompt-cache.js";

describe("supportsPromptCaching", () => {
  it("enables caching for Anthropic models", () => {
    expect(supportsPromptCaching("anthropic/claude-sonnet-4")).toBe(true);
    expect(supportsPromptCaching("openrouter:anthropic/claude-opus-4.8")).toBe(
      true,
    );
  });

  it("disables caching for non-Anthropic models", () => {
    expect(supportsPromptCaching("deepseek/deepseek-v4-flash")).toBe(false);
    expect(supportsPromptCaching("google/gemini-3.5-flash")).toBe(false);
  });
});

describe("promptCacheProviderOptions", () => {
  it("returns cache hints only for supported models", () => {
    expect(promptCacheProviderOptions("anthropic/claude-sonnet-4")).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(promptCacheProviderOptions("deepseek/deepseek-v4-flash")).toBeUndefined();
  });
});

describe("markPromptCacheBreakpoints", () => {
  it("marks the penultimate message for Anthropic models", () => {
    const aiMessages: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: "second" },
    ];

    markPromptCacheBreakpoints(aiMessages, "anthropic/claude-sonnet-4");

    expect(aiMessages[0].providerOptions).toBeUndefined();
    expect(aiMessages[1].providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(aiMessages[2].providerOptions).toBeUndefined();
  });

  it("skips marking when the model does not support caching", () => {
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
