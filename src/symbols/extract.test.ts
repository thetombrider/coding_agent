import { describe, expect, it } from "vitest";
import { extractFromSource } from "./extract.js";

describe("extractFromSource", () => {
  it("extracts TypeScript functions and classes", async () => {
    const source = `
export function greet(name: string): string {
  return \`Hello, \${name}\`;
}

export class Greeter {
  sayHi() {
    return greet("world");
  }
}
`;
    const result = await extractFromSource("src/math.ts", source);
    expect(result).not.toBeNull();
    const names = result!.symbols.map((s) => s.name);
    expect(names).toContain("greet");
    expect(names).toContain("Greeter");
    expect(result!.symbols.find((s) => s.name === "greet")?.exported).toBe(true);
  });

  it("extracts JavaScript symbols", async () => {
    const source = `
function add(a, b) {
  return a + b;
}

class Counter {
  inc() { return add(this.n, 1); }
}
`;
    const result = await extractFromSource("lib/util.js", source);
    expect(result).not.toBeNull();
    const names = result!.symbols.map((s) => s.name);
    expect(names).toContain("add");
    expect(names).toContain("Counter");
  });

  it("collects call references", async () => {
    const source = `
function helper() { return 1; }
function main() { return helper(); }
`;
    const result = await extractFromSource("src/app.ts", source);
    expect(result!.references.some((r) => r.to === "helper" && r.type === "call")).toBe(true);
  });

  it("returns null for unsupported extensions", async () => {
    const result = await extractFromSource("readme.md", "# hi");
    expect(result).toBeNull();
  });
});
