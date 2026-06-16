export interface WorkspaceExecOptions {
  onData: (chunk: Buffer) => void;
  signal?: AbortSignal;
  /** Timeout in seconds. */
  timeout?: number;
  env?: Record<string, string>;
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

  dispose(): Promise<void>;
}

export type SandboxKind = "local" | "e2b";
