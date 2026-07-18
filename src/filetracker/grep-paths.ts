import { resolvePath } from "../util/paths.js";

/**
 * Extract unique file paths from ripgrep --line-number output.
 * Match lines use `path:line:content`; context lines use `path-line-content`.
 */
export function pathsFromGrepOutput(cwd: string, output: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (!line || line === "(no matches)") continue;
    const path = parseGrepLinePath(line);
    if (!path) continue;
    const abs = resolvePath(cwd, path);
    if (seen.has(abs)) continue;
    seen.add(abs);
    paths.push(abs);
  }
  return paths;
}

function parseGrepLinePath(line: string): string | null {
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  const afterColon = line.slice(colon + 1);
  const secondColon = afterColon.indexOf(":");
  if (secondColon > 0 && /^\d+$/.test(afterColon.slice(0, secondColon))) {
    return line.slice(0, colon);
  }
  const dash = line.indexOf("-");
  if (dash <= 0) return null;
  const afterDash = line.slice(dash + 1);
  const secondDash = afterDash.indexOf("-");
  if (secondDash > 0 && /^\d+$/.test(afterDash.slice(0, secondDash))) {
    return line.slice(0, dash);
  }
  return null;
}
