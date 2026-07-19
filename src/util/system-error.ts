import { APICallError } from "@ai-sdk/provider";
import { RetryError } from "ai";

/**
 * Critical system-level error codes. These represent environmental failures
 * that affect every subsequent operation — retrying the same call (or any
 * other call) is futile, so the agent loop should terminate rather than feed
 * the error back to the model, which would otherwise retry indefinitely.
 *
 * Path-specific errors like EACCES/EPERM are intentionally excluded: they are
 * recoverable in the sense that the model can pivot to a different file or
 * approach, so they remain ordinary tool errors.
 */
const CRITICAL_CODES = new Set([
  "ENOSPC", // no space left on device (disk full)
  "EDQUOT", // disk quota exceeded
  "EROFS", // read-only file system
  "EMFILE", // too many open files (process limit)
  "ENFILE", // too many open files (system limit)
  "ENOMEM", // out of memory
  "EIO", // low-level I/O error
  // Network partitions and connectivity failures
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
]);

/** HTTP statuses that indicate permanent auth/billing failure — not retryable. */
const NON_RETRYABLE_HTTP_STATUSES = new Set([401, 402, 403]);

const RATE_LIMIT_HTTP_STATUS = 429;

const NON_RETRYABLE_HTTP_MESSAGE_RE = /\bHTTP\s+(401|402|403)\b/;
const RATE_LIMIT_HTTP_MESSAGE_RE = /\bHTTP\s+429\b/i;
const RATE_LIMIT_MESSAGE_RE = /rate.?limit/i;

function walkErrorChain(
  err: unknown,
  visit: (current: unknown) => boolean,
): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (visit(current)) return true;
    current =
      current instanceof Error && "cause" in current
        ? (current as Error & { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

function httpStatusCode(err: unknown): number | undefined {
  if (APICallError.isInstance(err) && err.statusCode !== undefined) {
    return err.statusCode;
  }
  if (typeof err === "object" && err !== null && "statusCode" in err) {
    const statusCode = (err as { statusCode: unknown }).statusCode;
    if (typeof statusCode === "number") return statusCode;
  }
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

function nodeErrorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function isRateLimitStatus(status: number | undefined): boolean {
  return status === RATE_LIMIT_HTTP_STATUS;
}

function isNonRetryableHttpStatus(status: number | undefined): boolean {
  return status !== undefined && NON_RETRYABLE_HTTP_STATUSES.has(status);
}

/**
 * True when `err` represents a rate limit (HTTP 429 or equivalent). These are
 * transient — the caller should retry with backoff rather than terminate or
 * feed the error back to the model immediately.
 */
export function isRateLimitError(err: unknown): boolean {
  if (RetryError.isInstance(err)) {
    const last = err.lastError ?? err.errors.at(-1);
    return last ? isRateLimitError(last) : false;
  }

  return walkErrorChain(err, (current) => {
    if (isRateLimitStatus(httpStatusCode(current))) return true;
    const message = errorMessage(current);
    return RATE_LIMIT_HTTP_MESSAGE_RE.test(message) || RATE_LIMIT_MESSAGE_RE.test(message);
  });
}

/**
 * True when `err` (or its cause chain) carries a Node `code` representing an
 * unrecoverable system failure, or a non-retryable HTTP API error (401/402/403).
 * Walks the cause chain like {@link isAbortError} so wrapped errors are still
 * detected. Rate limits (429) are explicitly excluded — use
 * {@link isRateLimitError} for those.
 */
export function isCriticalSystemError(err: unknown): boolean {
  if (isRateLimitError(err)) return false;

  if (RetryError.isInstance(err)) {
    const candidates = [...err.errors];
    if (err.lastError) candidates.push(err.lastError);
    return candidates.some((nested) => isCriticalSystemError(nested));
  }

  return walkErrorChain(err, (current) => {
    const code = nodeErrorCode(current);
    if (code && CRITICAL_CODES.has(code)) return true;

    const status = httpStatusCode(current);
    if (isNonRetryableHttpStatus(status)) return true;

    const message = errorMessage(current);
    if (NON_RETRYABLE_HTTP_MESSAGE_RE.test(message)) return true;

    return false;
  });
}
