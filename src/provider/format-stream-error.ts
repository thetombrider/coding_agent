import { APICallError } from "@ai-sdk/provider";
import { RetryError } from "ai";

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

/** Turn AI SDK / provider errors into a user-facing message for the TUI. */
export function formatStreamError(error: unknown): string {
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

  return message;
}
