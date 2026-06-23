import { createOpenAiCompatibleProvider } from "../openai-compatible.js";

/** Curated model for the `/model` picker when Opencode Go is active. */
export const OPENCODE_GO_PICKER_MODELS = ["opencode-go"] as const;

/** Opencode Go — fast OpenAI-compatible model from opencode.ai. */
export const opencodeGoProvider = createOpenAiCompatibleProvider({
  id: "opencode-go",
  displayName: "Opencode Go",
  envVar: "OPENCODE_API_KEY",
  configSection: "opencode",
  baseURL: "https://api.opencode.ai/v1",
  pickerModels: OPENCODE_GO_PICKER_MODELS,
  defaultModels: { main: "opencode-go", cheap: "opencode-go" },
});

/** Curated model for the `/model` picker when Opencode Zen is active. */
export const OPENCODE_ZEN_PICKER_MODELS = ["opencode-zen"] as const;

/** Opencode Zen — capable OpenAI-compatible model from opencode.ai. */
export const opencodeZenProvider = createOpenAiCompatibleProvider({
  id: "opencode-zen",
  displayName: "Opencode Zen",
  envVar: "OPENCODE_API_KEY",
  configSection: "opencode",
  baseURL: "https://api.opencode.ai/v1",
  pickerModels: OPENCODE_ZEN_PICKER_MODELS,
  defaultModels: { main: "opencode-zen", cheap: "opencode-zen" },
});
