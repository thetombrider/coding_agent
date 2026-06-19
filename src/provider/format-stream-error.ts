import { APICallError } from "@ai-sdk/provider";
import { RetryError } from "ai";

const ANTHROPIC_OAUTH_HINT =
  "Anthropic subscription OAuth tokens are only supported in Claude Code and claude.ai — "
  + "not in third-party apps calling the Messages API. "
  + "Use a Console API key instead: /providers configure anthropic or set ANTHROPIC_API_KEY "
  + "(https://platform.claude.com).";

function parseAnthropicErrorBody(responseBody?: string): string | undefined {
  if (!responseBody?.trim()) return undefined;
  try {
    const json = JSON.parse(responseBody) as {
      error?: { type?: string; message?: string };
      type?: string;
      message?: string;
    };
    if (json.error?.message) {
      const type = json.error.type ? `[${json.error.type}] ` : "";
      return `${type}${json.error.message}`;
    }
    if (json.message) return json.message;
  } catch {
    if (responseBody.length <= 300) return responseBody;
  }
  return undefined;
}

function formatApiCallError(error: APICallError): string {
  const fromBody = parseAnthropicErrorBody(error.responseBody);
  const parts: string[] = [];
  if (fromBody) parts.push(fromBody);
  else if (error.message && error.message !== "Error") parts.push(error.message);
  if (error.statusCode !== undefined) parts.push(`HTTP ${error.statusCode}`);
  return parts.join(" — ") || `API request failed (${error.url})`;
}

function looksLikeOAuthBlock(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("oauth")
    || lower.includes("invalid x-api-key")
    || lower.includes("invalid bearer")
    || lower.includes("authentication")
    || lower.includes("not supported")
    || lower.includes("unauthorized")
  );
}

/** Turn AI SDK / provider errors into a user-facing message for the TUI. */
export function formatStreamError(error: unknown, opts?: { anthropicOAuth?: boolean }): string {
  let root = error;
  let attemptNote: string | undefined;

  if (RetryError.isInstance(error)) {
    root = error.lastError ?? error.errors.at(-1) ?? error;
    if (error.errors.length > 1) {
      attemptNote = `after ${error.errors.length} attempts`;
    }
  }

  let message: string;
  if (APICallError.isInstance(root)) {
    message = formatApiCallError(root);
  } else if (root instanceof Error) {
    message = root.message.trim() || root.name || "unknown error";
  } else {
    message = String(root);
  }

  if (message === "Error" && RetryError.isInstance(error)) {
    const nested = error.errors.find((e) => APICallError.isInstance(e));
    if (nested && APICallError.isInstance(nested)) {
      message = formatApiCallError(nested);
    }
  }

  if (attemptNote && !message.includes("attempt")) {
    message = `${message} (${attemptNote})`;
  }

  if (opts?.anthropicOAuth && looksLikeOAuthBlock(message)) {
    message = `${message}\n\n${ANTHROPIC_OAUTH_HINT}`;
  }

  return message;
}

export { ANTHROPIC_OAUTH_HINT };
