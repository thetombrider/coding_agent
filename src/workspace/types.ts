export interface WorkspaceExecOptions {
  onData: (chunk: Buffer) => void;
  signal?: AbortSignal;
  /** Timeout in seconds. */
  timeout?: number;
  env?: Record<string, string>;
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
  ): Promise<{ exitCode: number | null }>;

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
