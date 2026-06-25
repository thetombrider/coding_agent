import { parseApprovalMode } from "./approval/policy.js";
import type { ApprovalMode } from "./approval/policy.js";

/** Value following `--flag`/`-f`, or undefined if absent or itself a flag. */
export function flagValue(args: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const idx = args.indexOf(name);
    if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith("-")) {
      return args[idx + 1];
    }
  }
  return undefined;
}

export interface ParsedCliArgs {
  /** Positional words joined into the user's prompt (empty when none). */
  prompt: string;
  useFaux: boolean;
  headless: boolean;
  listSessions: boolean;
  chat: boolean;
  resumeId?: string;
  /** Run the session in a git worktree on an isolated branch. */
  worktree: boolean;
  autoAcceptCli: boolean;
  approvalMode: ApprovalMode;
}

/**
 * Parse `orin`'s CLI argv (already stripped of `node`/script). The base approval
 * mode (used when no approval flag is present) is resolved lazily so callers and
 * tests can inject a deterministic value instead of reading env/config.
 */
export function parseCliArgs(
  argv: string[],
  resolveBaseApprovalMode: () => ApprovalMode = parseApprovalMode,
): ParsedCliArgs {
  const flags = new Set(argv.filter((a) => a.startsWith("-")));
  const prompt = argv.filter((a) => !a.startsWith("-")).join(" ").trim();

  const useFaux = flags.has("--faux");
  const autoAcceptCli = flags.has("--auto-accept") || useFaux;
  const approvalMode: ApprovalMode = flags.has("--plan")
    ? "plan"
    : autoAcceptCli
      ? "auto-accept"
      : resolveBaseApprovalMode();

  return {
    prompt,
    useFaux,
    headless: flags.has("--headless"),
    listSessions: flags.has("--list-sessions") || flags.has("-l"),
    chat: flags.has("--chat"),
    resumeId: flagValue(argv, "--resume", "-r"),
    worktree: flags.has("--worktree"),
    autoAcceptCli,
    approvalMode,
  };
}
