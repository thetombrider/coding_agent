/**
 * Environment variable expansion for MCP config values.
 *
 * Supported placeholder syntax (matches the patterns used by Claude Code and
 * Cursor, so a config written for either client also works here):
 *
 *   - `${env:VAR}`                  — required; missing var → reported via `missing`
 *   - `${env:VAR:-default}`         — optional; missing var → falls back to `default`
 *   - `${VAR}`                      — required (shorthand for `${env:VAR}`)
 *   - `${VAR:-default}`             — optional  (shorthand for `${env:VAR:-default}`)
 *
 * Variable names follow POSIX: must start with a letter or underscore and
 * contain only letters, digits, and underscores.
 *
 * Expansion happens at *load time* in `loadMcpConfig()` — values stored on
 * disk in `~/.orin/mcp.json` are left untouched so secrets stay out of the
 * file.
 */

const PLACEHOLDER = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g;

export interface EnvExpansionResult {
  /** The string with placeholders resolved (or kept verbatim for missing required vars). */
  value: string;
  /** Names of env vars that were referenced without a default and are unset. */
  missing: string[];
}

function pushMissing(missing: string[], name: string): void {
  if (!missing.includes(name)) missing.push(name);
}

export function expandEnvString(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
): EnvExpansionResult {
  const missing: string[] = [];
  const value = input.replace(
    PLACEHOLDER,
    (match, varName: string, defaultValue: string | undefined) => {
      const v = env[varName];
      if (v !== undefined) return v;
      if (defaultValue !== undefined) return defaultValue;
      pushMissing(missing, varName);
      return match;
    },
  );
  return { value, missing };
}

export interface EnvRecordExpansionResult {
  value: Record<string, string>;
  missing: string[];
}

export function expandEnvRecord(
  record: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): EnvRecordExpansionResult {
  const missing: string[] = [];
  const value: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    const r = expandEnvString(v, env);
    if (r.missing.length) {
      for (const m of r.missing) pushMissing(missing, m);
    }
    value[k] = r.value;
  }
  return { value, missing };
}

export interface EnvListExpansionResult {
  value: string[];
  missing: string[];
}

export function expandEnvList(
  list: string[],
  env: NodeJS.ProcessEnv = process.env,
): EnvListExpansionResult {
  const missing: string[] = [];
  const value: string[] = list.map((s) => {
    const r = expandEnvString(s, env);
    if (r.missing.length) {
      for (const m of r.missing) pushMissing(missing, m);
    }
    return r.value;
  });
  return { value, missing };
}

export function formatMissingVars(missing: string[]): string {
  return missing.map((v) => `\${${v}}`).join(", ");
}
