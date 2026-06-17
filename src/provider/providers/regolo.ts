import { createOpenAiCompatibleProvider } from "../openai-compatible.js";

/** Regolo AI — EU-hosted OpenAI-compatible inference (https://regolo.ai). */
export const regoloProvider = createOpenAiCompatibleProvider({
  id: "regolo",
  displayName: "Regolo AI",
  envVar: "REGOLO_API_KEY",
  configSection: "regolo",
  baseURL: "https://api.regolo.ai/v1",
  idPrefix: "regolo:",
});
