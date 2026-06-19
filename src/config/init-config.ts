import { ensureConfigFile } from "./config.js";

/** Seed ~/.orin/config.json with defaults when missing. API keys are configured in the TUI. */
ensureConfigFile();
