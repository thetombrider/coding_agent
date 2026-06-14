import { afterEach, describe, expect, it } from "vitest";
import { loadModelConfig } from "./models.js";

describe("loadModelConfig", () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it("uses fallbacks when env is unset", () => {
    delete process.env.MINICODER_MODEL;
    delete process.env.MINICODER_CHEAP_MODEL;
    expect(loadModelConfig()).toEqual({
      main: "anthropic/claude-sonnet-4",
      cheap: "deepseek/deepseek-v4-flash",
    });
  });

  it("reads MINICODER_MODEL and MINICODER_CHEAP_MODEL from env", () => {
    process.env.MINICODER_MODEL = "openai/gpt-4o";
    process.env.MINICODER_CHEAP_MODEL = "meta-llama/llama-3.1-8b-instruct";
    expect(loadModelConfig()).toEqual({
      main: "openai/gpt-4o",
      cheap: "meta-llama/llama-3.1-8b-instruct",
    });
  });
});
