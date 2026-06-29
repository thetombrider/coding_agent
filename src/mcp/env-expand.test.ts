import { describe, expect, it } from "vitest";
import {
  expandEnvList,
  expandEnvRecord,
  expandEnvString,
  formatMissingVars,
} from "./env-expand.js";

describe("expandEnvString", () => {
  it("returns the input unchanged when no placeholders are present", () => {
    expect(expandEnvString("plain text", {})).toEqual({ value: "plain text", missing: [] });
  });

  it("expands ${env:VAR} when the env var is set", () => {
    expect(expandEnvString("Bearer ${env:TOKEN}", { TOKEN: "abc" })).toEqual({
      value: "Bearer abc",
      missing: [],
    });
  });

  it("expands ${VAR} (no prefix) when the env var is set", () => {
    expect(expandEnvString("Bearer ${TOKEN}", { TOKEN: "abc" })).toEqual({
      value: "Bearer abc",
      missing: [],
    });
  });

  it("reports missing required env vars", () => {
    const r = expandEnvString("Bearer ${env:TOKEN}", {});
    expect(r.value).toBe("Bearer ${env:TOKEN}");
    expect(r.missing).toEqual(["TOKEN"]);
  });

  it("uses the default when the env var is unset (Cursor syntax)", () => {
    expect(expandEnvString("${env:HOST:-localhost}", {})).toEqual({
      value: "localhost",
      missing: [],
    });
  });

  it("uses the default when the env var is unset (Claude Code syntax)", () => {
    expect(expandEnvString("${HOST:-localhost}", {})).toEqual({
      value: "localhost",
      missing: [],
    });
  });

  it("prefers the env var over the default when both are present", () => {
    expect(expandEnvString("${env:HOST:-localhost}", { HOST: "example.com" })).toEqual({
      value: "example.com",
      missing: [],
    });
  });

  it("expands multiple placeholders in one string", () => {
    expect(
      expandEnvString("https://${env:HOST}:${env:PORT:-8080}/mcp", {
        HOST: "api.example.com",
      }),
    ).toEqual({ value: "https://api.example.com:8080/mcp", missing: [] });
  });

  it("aggregates multiple missing vars", () => {
    const r = expandEnvString("${A}/${B:-fallback}/${C}", { B: "set" });
    expect(r.missing).toEqual(["A", "C"]);
  });

  it("treats defaults containing placeholders literally", () => {
    expect(expandEnvString("${X:-${Y:-safe}}", {})).toEqual({
      value: "${Y:-safe}",
      missing: [],
    });
  });

  it("ignores invalid variable names", () => {
    expect(expandEnvString("${1NVALID}", { "1NVALID": "x" })).toEqual({
      value: "${1NVALID}",
      missing: [],
    });
    expect(expandEnvString("${not-dash}", { "not-dash": "x" })).toEqual({
      value: "${not-dash}",
      missing: [],
    });
  });

  it("matches env vars case-sensitively", () => {
    expect(expandEnvString("${token}", { TOKEN: "x" })).toEqual({
      value: "${token}",
      missing: ["token"],
    });
  });
});

describe("expandEnvRecord", () => {
  it("expands every value and aggregates missing vars", () => {
    const r = expandEnvRecord(
      { Authorization: "Bearer ${env:ORIN_TEST_TOKEN}", Accept: "${env:ORIN_TEST_ACCEPT:-application/json}" },
      { ORIN_TEST_TOKEN: "t0k" },
    );
    expect(r.value).toEqual({
      Authorization: "Bearer t0k",
      Accept: "application/json",
    });
    expect(r.missing).toEqual([]);
  });

  it("returns the original record when no placeholders are present", () => {
    const r = expandEnvRecord({ "X-Foo": "bar" }, {});
    expect(r.value).toEqual({ "X-Foo": "bar" });
    expect(r.missing).toEqual([]);
  });
});

describe("expandEnvList", () => {
  it("expands each element and aggregates missing vars", () => {
    const r = expandEnvList(["--token=${env:TOKEN}", "--host=${env:HOST:-localhost}"], {});
    expect(r.value).toEqual(["--token=${env:TOKEN}", "--host=localhost"]);
    expect(r.missing).toEqual(["TOKEN"]);
  });
});

describe("formatMissingVars", () => {
  it("formats single and multiple missing vars", () => {
    expect(formatMissingVars([])).toBe("");
    expect(formatMissingVars(["A"])).toBe("${A}");
    expect(formatMissingVars(["A", "B"])).toBe("${A}, ${B}");
  });
});
