import { createInterface } from "node:readline/promises";
import { ensureConfigFile, hasOpenRouterApiKey, saveConfig } from "./config.js";

/**
 * Prompt for an OpenRouter API key and persist it to ~/.orin/config.json so
 * `orin` works from any directory. Skips when a key is already configured
 * (env var or config) or when stdin is not interactive (e.g. piped installs).
 */
async function promptForApiKey(): Promise<void> {
  if (hasOpenRouterApiKey()) return;

  if (!process.stdin.isTTY) {
    console.log(
      "No OPENROUTER_API_KEY found. Add it to ~/.orin/config.json (provider.openrouter.apiKey) or set the env var.",
    );
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("OpenRouter API key (get one at https://openrouter.ai/keys, blank to skip): ")).trim();
    if (answer) {
      saveConfig({ provider: { openrouter: { apiKey: answer } } });
      console.log("Saved API key to ~/.orin/config.json — orin now works from any directory.");
    } else {
      console.log("Skipped. Add it later to ~/.orin/config.json under provider.openrouter.apiKey.");
    }
  } finally {
    rl.close();
  }
}

ensureConfigFile();
await promptForApiKey();
