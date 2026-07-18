import type { MutationLock, MutationMode } from "./mutation-queue.js";

/** Shell redirection targets that are not workspace files. */
const SKIP_TARGETS = new Set([
  "/dev/null",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "&1",
  "&2",
  "-",
]);

const READ_VERBS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "stat",
  "file",
  "diff",
  "cmp",
  "strings",
  "nl",
  "od",
  "xxd",
  "hexdump",
]);

const WRITE_VERBS = new Set([
  "rm",
  "mv",
  "cp",
  "touch",
  "mkdir",
  "rmdir",
  "ln",
  "chmod",
  "chown",
  "truncate",
  "tee",
  "install",
  "patch",
  "shred",
]);

const GIT_WRITE_SUBCOMMANDS = new Set([
  "checkout",
  "restore",
  "apply",
  "clean",
  "reset",
  "revert",
  "merge",
  "cherry-pick",
]);

function stripQuotes(token: string): string {
  if (
    (token.startsWith("'") && token.endsWith("'"))
    || (token.startsWith('"') && token.endsWith('"'))
  ) {
    return token.slice(1, -1);
  }
  return token;
}

function splitSegments(command: string): string[] {
  return command
    .split(/\s*(?:;|&&|\|\||\|)\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function redirectionTargets(segment: string): string[] {
  const targets: string[] = [];
  const re = /(?:^|[\s])(?:\d>>?|>>?|&>)\s*([^\s|&;<>]+)/g;
  for (const match of segment.matchAll(re)) {
    const raw = stripQuotes(match[1]!);
    if (!raw || SKIP_TARGETS.has(raw)) continue;
    targets.push(raw);
  }
  return targets;
}

function pathArgsAfterFlags(tokens: string[], startIndex: number): string[] {
  const paths: string[] = [];
  for (let i = startIndex; i < tokens.length; i += 1) {
    const token = stripQuotes(tokens[i]!);
    if (!token || token.startsWith("-")) continue;
    paths.push(token);
  }
  return paths;
}

function segmentLocks(
  segment: string,
  resolvePath: (cwd: string, path: string) => string,
  cwd: string,
): MutationLock[] {
  const redirs = redirectionTargets(segment);
  if (redirs.length > 0) {
    return redirs.map((path) => lockPath(path, "exclusive", resolvePath, cwd));
  }

  const tokens = tokenize(segment.replace(/^(?:\w+=\S+\s+)*/, ""));
  if (tokens.length === 0) return [];

  const verb = stripQuotes(tokens[0]!).toLowerCase();

  if (verb === "sed" && tokens.some((token) => /^-i\S*$/.test(token))) {
    const paths = pathArgsAfterFlags(tokens, 1).slice(-1);
    return paths.map((path) => lockPath(path, "exclusive", resolvePath, cwd));
  }

  if (verb === "git" && tokens.length >= 2) {
    const sub = stripQuotes(tokens[1]!).toLowerCase();
    if (GIT_WRITE_SUBCOMMANDS.has(sub)) {
      const paths = pathArgsAfterFlags(tokens, 2);
      if (paths.length > 0) {
        return paths.map((path) => lockPath(path, "exclusive", resolvePath, cwd));
      }
    }
    return [];
  }

  if (WRITE_VERBS.has(verb)) {
    const paths = pathArgsAfterFlags(tokens, 1);
    return paths.map((path) => lockPath(path, "exclusive", resolvePath, cwd));
  }

  if (READ_VERBS.has(verb)) {
    const paths = pathArgsAfterFlags(tokens, 1);
    return paths.map((path) => lockPath(path, "shared", resolvePath, cwd));
  }

  return [];
}

function lockPath(
  path: string,
  mode: MutationMode,
  resolvePath: (cwd: string, path: string) => string,
  cwd: string,
): MutationLock {
  return { key: resolvePath(cwd, path), mode };
}

export function dedupeMutationLocks(locks: MutationLock[]): MutationLock[] {
  const byKey = new Map<string, MutationMode>();
  for (const lock of locks) {
    const existing = byKey.get(lock.key);
    if (!existing || lock.mode === "exclusive") {
      byKey.set(lock.key, existing === "exclusive" ? "exclusive" : lock.mode);
    }
  }
  return [...byKey.entries()].map(([key, mode]) => ({ key, mode }));
}

/** Best-effort path locks for a bash command string. */
export function bashMutationLocks(
  command: string,
  resolvePath: (cwd: string, path: string) => string,
  cwd: string,
): MutationLock[] {
  const locks: MutationLock[] = [];
  for (const segment of splitSegments(command)) {
    locks.push(...segmentLocks(segment, resolvePath, cwd));
  }
  return dedupeMutationLocks(locks);
}
