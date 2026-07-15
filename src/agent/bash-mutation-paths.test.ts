import { describe, expect, it } from "vitest";
import { bashMutationLocks } from "./bash-mutation-paths.js";

const resolve = (cwd: string, path: string) => `${cwd}/${path}`;

describe("bashMutationLocks", () => {
  it("locks redirection targets exclusively", () => {
    expect(bashMutationLocks('echo hi > out.txt', resolve, "/proj")).toEqual([
      { key: "/proj/out.txt", mode: "exclusive" },
    ]);
  });

  it("locks append redirections exclusively", () => {
    expect(bashMutationLocks("cat log.txt >> combined.log", resolve, "/proj")).toEqual([
      { key: "/proj/combined.log", mode: "exclusive" },
    ]);
  });

  it("locks rm targets exclusively", () => {
    expect(bashMutationLocks("rm -f src/old.ts", resolve, "/proj")).toEqual([
      { key: "/proj/src/old.ts", mode: "exclusive" },
    ]);
  });

  it("locks mv source and destination exclusively", () => {
    expect(bashMutationLocks("mv src/a.ts src/b.ts", resolve, "/proj")).toEqual([
      { key: "/proj/src/a.ts", mode: "exclusive" },
      { key: "/proj/src/b.ts", mode: "exclusive" },
    ]);
  });

  it("locks sed -i targets exclusively", () => {
    expect(bashMutationLocks("sed -i 's/a/b/' pkg.json", resolve, "/proj")).toEqual([
      { key: "/proj/pkg.json", mode: "exclusive" },
    ]);
  });

  it("locks cat targets as shared reads", () => {
    expect(bashMutationLocks("cat README.md", resolve, "/proj")).toEqual([
      { key: "/proj/README.md", mode: "shared" },
    ]);
  });

  it("combines locks across chained commands", () => {
    expect(bashMutationLocks("cat a.txt && echo x > b.txt", resolve, "/proj")).toEqual([
      { key: "/proj/a.txt", mode: "shared" },
      { key: "/proj/b.txt", mode: "exclusive" },
    ]);
  });

  it("ignores non-file redirection targets", () => {
    expect(bashMutationLocks("npm test 2>/dev/null", resolve, "/proj")).toEqual([]);
  });

  it("returns no locks for commands without detectable paths", () => {
    expect(bashMutationLocks("git status", resolve, "/proj")).toEqual([]);
    expect(bashMutationLocks("bun run test", resolve, "/proj")).toEqual([]);
  });
});
