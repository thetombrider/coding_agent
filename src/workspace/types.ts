export interface WorkspaceExecOptions {
  onData: (chunk: Buffer) => void;
  signal?: AbortSignal;
  /** Timeout in seconds. */
  timeout?: number;
  env?: Record<string, string>;
  /**
   * Hard cap (bytes) on output forwarded to `onData`. Once exceeded the child is
   * terminated and `truncated` is set, bounding memory and protecting the agent
   * from a runaway command that would otherwise exhaust the context window (#146).
   */
  maxBuffer?: number;
}

/** Lightweight stat result — enough to distinguish files from directories. */
export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
}

export interface Workspace {
  readonly kind: SandboxKind;

  exec(
    command: string,
    cwd: string,
    opts: WorkspaceExecOptions,
  ): Promise<{ exitCode: number | null; truncated?: boolean; timedOut?: boolean }>;

  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  list(path: string): Promise<string[]>;
  /** Stat a path; resolves to `null` when it does not exist. */
  stat(path: string): Promise<FileStat | null>;
  /** Delete a single file (callers must ensure it is not a directory). */
  deleteFile(path: string): Promise<void>;
  /** Move/rename a path from `source` to `destination`. */
  move(source: string, destination: string): Promise<void>;

  dispose(): Promise<void>;
}

export type SandboxKind = "local" | "e2b";
