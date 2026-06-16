import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config as loadDotenv } from "dotenv";

/**
 * Load environment variables from `.env` files in a location-independent way.
 *
 * `dotenv/config` only reads `.env` from the current working directory, so a key
 * stored in the cloned repo's `.env` is invisible when `orin` runs from anywhere
 * else. We load the global `~/.orin/.env` first (the canonical home for the CLI),
 * then a cwd-local `.env` for repo development convenience.
 *
 * dotenv never overrides variables that are already set, so precedence is:
 *   real shell env  >  cwd .env  >  ~/.orin/.env
 */
export function loadEnv(): void {
  const cwdEnv = join(process.cwd(), ".env");
  if (existsSync(cwdEnv)) loadDotenv({ path: cwdEnv });

  const globalEnv = join(homedir(), ".orin", ".env");
  if (existsSync(globalEnv)) loadDotenv({ path: globalEnv });
}
