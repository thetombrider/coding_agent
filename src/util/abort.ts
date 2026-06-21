/** True when `err` (or its cause chain) represents an AbortSignal cancellation. */
export function isAbortError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof DOMException && current.name === "AbortError") return true;
    if (current instanceof Error && current.name === "AbortError") return true;
    if (typeof current === "object" && current !== null && "name" in current) {
      if ((current as { name: unknown }).name === "AbortError") return true;
    }
    current =
      current instanceof Error && "cause" in current
        ? (current as Error & { cause?: unknown }).cause
        : undefined;
  }
  return false;
}
