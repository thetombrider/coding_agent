import { createInterface } from "node:readline/promises";
import { ensureConfigFile, hasE2BApiKey, hasOpenRouterApiKey, saveConfig } from "./config.js";

/**
 * Prompt for API keys and persist them to ~/.orin/config.json so `orin` works
 * from any directory. Skips when a key is already configured (env var or config)
 * or when stdin is not interactive (e.g. piped installs).
 */
async function promptForOpenRouterApiKey(): Promise<void> {
  if (hasOpenRouterApiKey()) return;

  if (!process.stdin.isTTY) {
    console.log(
      "No OPENROUTER_API_KEY found. Add it to ~/.orin/config.json (provider.openrouter.apiKey) or set the env var.",
    );
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question("OpenRouter API key (get one at https://openrouter.ai/keys, blank to skip): ")
    ).trim();
    if (answer) {
      saveConfig({ provider: { openrouter: { apiKey: answer } } });
      console.log("Saved OpenRouter API key to ~/.orin/config.json.");
    } else {
      console.log("Skipped OpenRouter key. Add it later under provider.openrouter.apiKey.");
    }
  } finally {
    rl.close();
  }
}

async function promptForE2BApiKey(): Promise<void> {
  if (hasE2BApiKey()) return;

  if (!process.stdin.isTTY) {
    console.log(
      "No E2B_API_KEY found. Add it to ~/.orin/config.json (sandbox.e2b.apiKey) or set the env var to use /sandbox e2b.",
    );
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question("E2B API key (optional — for /sandbox e2b, get one at https://e2b.dev/docs/api-key, blank to skip): ")
    ).trim();
    if (answer) {
      saveConfig({ sandbox: { e2b: { apiKey: answer } } });
      console.log("Saved E2B API key to ~/.orin/config.json.");
    } else {
      console.log("Skipped E2B key. Add it later under sandbox.e2b.apiKey.");
    }
  } finally {
    rl.close();
  }
}

ensureConfigFile();
await promptForOpenRouterApiKey();
await promptForE2BApiKey();
