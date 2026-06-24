import type { Reference, Symbol } from "./types.js";

export class SymbolIndex {
  private readonly byName = new Map<string, Symbol[]>();
  private readonly byFile = new Map<string, Symbol[]>();
  private readonly references: Reference[] = [];
  private readonly callGraph = new Map<string, Set<string>>();

  get symbolCount(): number {
    let n = 0;
    for (const list of this.byName.values()) n += list.length;
    return n;
  }

  get fileCount(): number {
    return this.byFile.size;
  }

  get referenceCount(): number {
    return this.references.length;
  }

  replaceFile(file: string, symbols: Symbol[], references: Reference[]): void {
    this.removeFileWithoutRebuild(file);
    this.addFileWithoutRebuild(file, symbols, references);
    this.rebuildCallGraph();
  }

  loadFiles(entries: Array<{ file: string; symbols: Symbol[]; references: Reference[] }>): void {
    for (const entry of entries) {
      this.removeFileWithoutRebuild(entry.file);
      this.addFileWithoutRebuild(entry.file, entry.symbols, entry.references);
    }
    this.rebuildCallGraph();
  }

  removeFile(file: string): void {
    if (!this.byFile.has(file)) return;
    this.removeFileWithoutRebuild(file);
    this.rebuildCallGraph();
  }

  getFileData(file: string): { symbols: Symbol[]; references: Reference[] } | null {
    const symbols = this.byFile.get(file);
    if (!symbols) return null;
    return {
      symbols: [...symbols],
      references: this.references.filter((ref) => ref.file === file),
    };
  }

  indexedFiles(): string[] {
    return [...this.byFile.keys()];
  }

  private removeFileWithoutRebuild(file: string): void {
    const old = this.byFile.get(file);
    if (!old) return;

    for (const sym of old) {
      const list = this.byName.get(sym.name);
      if (!list) continue;
      const next = list.filter((s) => s.id !== sym.id);
      if (next.length) this.byName.set(sym.name, next);
      else this.byName.delete(sym.name);
    }
    this.byFile.delete(file);

    const remainingRefs: Reference[] = [];
    for (const ref of this.references) {
      if (ref.file === file) continue;
      remainingRefs.push(ref);
    }
    this.references.length = 0;
    this.references.push(...remainingRefs);
  }

  private addFileWithoutRebuild(file: string, symbols: Symbol[], references: Reference[]): void {
    this.byFile.set(file, symbols);
    for (const sym of symbols) {
      const list = this.byName.get(sym.name) ?? [];
      list.push(sym);
      this.byName.set(sym.name, list);
    }
    for (const ref of references) this.references.push(ref);
  }

  getDefinitions(name: string): Symbol[] {
    return [...(this.byName.get(name) ?? [])];
  }

  searchByPrefix(prefix: string, limit = 50): Symbol[] {
    const lower = prefix.toLowerCase();
    const out: Symbol[] = [];
    for (const [name, syms] of this.byName) {
      if (!name.toLowerCase().includes(lower)) continue;
      out.push(...syms);
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  getReferences(name: string): Reference[] {
    return this.references.filter((r) => r.to === name);
  }

  getCallers(name: string): Symbol[] {
    const defs = this.getDefinitions(name);
    const callerIds = new Set<string>();
    for (const def of defs) {
      for (const id of this.callGraph.get(def.id) ?? []) callerIds.add(id);
    }
    const out: Symbol[] = [];
    for (const list of this.byName.values()) {
      for (const sym of list) {
        if (callerIds.has(sym.id)) out.push(sym);
      }
    }
    return out;
  }

  allSymbols(): Symbol[] {
    const out: Symbol[] = [];
    for (const list of this.byName.values()) out.push(...list);
    return out;
  }

  private rebuildCallGraph(): void {
    this.callGraph.clear();
    for (const ref of this.references) {
      if (ref.type !== "call" || !ref.fromId) continue;
      for (const target of this.byName.get(ref.to) ?? []) {
        let callers = this.callGraph.get(target.id);
        if (!callers) {
          callers = new Set();
          this.callGraph.set(target.id, callers);
        }
        callers.add(ref.fromId);
      }
    }
  }
}
