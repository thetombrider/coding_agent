export interface ReadRecord {
  readAt: number;
  mtimeAtRead: number;
}

export type StalenessReason = "never_read" | "stale";

export class ReadTracker {
  private readonly records = new Map<string, ReadRecord>();
  private readonly pendingWarnings = new Map<string, string>();

  recordRead(absPath: string, mtimeMs: number): void {
    this.records.set(absPath, { readAt: Date.now(), mtimeAtRead: mtimeMs });
  }

  /** After a successful agent write/edit, treat the file as read at the new mtime. */
  markWritten(absPath: string, mtimeMs: number): void {
    this.recordRead(absPath, mtimeMs);
    this.pendingWarnings.delete(absPath);
  }

  checkStale(absPath: string, currentMtimeMs: number): StalenessReason | null {
    const record = this.records.get(absPath);
    if (!record) return "never_read";
    if (currentMtimeMs > record.mtimeAtRead) return "stale";
    return null;
  }

  setPendingWarning(absPath: string, warning: string): void {
    this.pendingWarnings.set(absPath, warning);
  }

  takePendingWarning(absPath: string): string | undefined {
    const warning = this.pendingWarnings.get(absPath);
    this.pendingWarnings.delete(absPath);
    return warning;
  }
}
