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

  it("extracts Python functions, classes, and methods", async () => {
    const source = `
def greet(name: str) -> str:
    return f"Hello, {name}"

class Greeter:
    def say_hi(self):
        return greet("world")

@staticmethod
def helper():
    return 1
`;
    const result = await extractFromSource("src/greet.py", source);
    expect(result).not.toBeNull();
    const names = result!.symbols.map((s) => s.name);
    expect(names).toContain("greet");
    expect(names).toContain("Greeter");
    expect(names).toContain("say_hi");
    expect(names).toContain("helper");
    expect(result!.symbols.find((s) => s.name === "say_hi")?.kind).toBe("method");
  });

  it("collects Python call and import references", async () => {
    const source = `
from math import sqrt
import os

def main():
    return sqrt(os.path)
`;
    const result = await extractFromSource("src/app.py", source);
    expect(result!.references.some((r) => r.to === "sqrt" && r.type === "import")).toBe(true);
    expect(result!.references.some((r) => r.to === "os" && r.type === "import")).toBe(true);
    expect(result!.references.some((r) => r.to === "sqrt" && r.type === "call")).toBe(true);
  });

  it("collects Python cross-function call references", async () => {
    const source = `
def helper():
    return 1

def main():
    return helper()
`;
    const result = await extractFromSource("src/app.py", source);
    expect(result!.references.some((r) => r.to === "helper" && r.type === "call")).toBe(true);
  });
});
