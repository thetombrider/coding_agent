/**
 * Per-key promise chain so concurrent mutations on the same path run serially
 * while unrelated work proceeds in parallel.
 */
export class MutationQueue {
  private readonly chains = new Map<string, Promise<unknown>>();

  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(fn);
    this.chains.set(
      key,
      next.finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      }),
    );
    return next;
  }
}

const WRITE_TOOL_NAMES = new Set(["write", "edit"]);

export function isWriteToolName(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name);
}

export function writeMutationKey(
  name: string,
  args: unknown,
  resolvePath: (cwd: string, path: string) => string,
  cwd: string,
): string | null {
  if (!isWriteToolName(name)) return null;
  if (typeof args !== "object" || args === null) return null;
  const path = (args as { path?: unknown }).path;
  if (typeof path !== "string" || !path) return null;
  return resolvePath(cwd, path);
}
