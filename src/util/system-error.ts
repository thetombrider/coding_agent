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
]);

/**
 * True when `err` (or its cause chain) carries a Node `code` representing an
 * unrecoverable system failure. Walks the cause chain like {@link isAbortError}
 * so wrapped errors are still detected.
 */
export function isCriticalSystemError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === "object" && current !== null && "code" in current) {
      const code = (current as { code: unknown }).code;
      if (typeof code === "string" && CRITICAL_CODES.has(code)) return true;
    }
    current =
      current instanceof Error && "cause" in current
        ? (current as Error & { cause?: unknown }).cause
        : undefined;
  }
  return false;
}
