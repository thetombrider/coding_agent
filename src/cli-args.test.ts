import { describe, expect, it } from "vitest";
import { flagValue, parseCliArgs } from "./cli-args.js";

// Deterministic base mode so tests never read env/config.
const base = () => "normal" as const;

describe("flagValue", () => {
  it("returns the value following a long flag", () => {
    expect(flagValue(["--resume", "abc123"], "--resume")).toBe("abc123");
  });

  it("matches any of several aliases", () => {
    expect(flagValue(["-r", "xyz"], "--resume", "-r")).toBe("xyz");
  });

  it("returns undefined when the flag is absent", () => {
    expect(flagValue(["--faux"], "--resume", "-r")).toBeUndefined();
  });

  it("returns undefined when the next token is itself a flag", () => {
    expect(flagValue(["--resume", "--faux"], "--resume")).toBeUndefined();
  });

  it("returns undefined when the flag is the last token", () => {
    expect(flagValue(["--resume"], "--resume")).toBeUndefined();
  });
});

describe("parseCliArgs", () => {
  it("treats positional words as the prompt", () => {
    const parsed = parseCliArgs(["fix", "the", "bug"], base);
    expect(parsed.prompt).toBe("fix the bug");
    expect(parsed.useFaux).toBe(false);
    expect(parsed.headless).toBe(false);
  });

  it("returns an empty prompt when only flags are passed", () => {
    expect(parseCliArgs(["--faux"], base).prompt).toBe("");
  });

  it("detects --faux and implies auto-accept", () => {
    const parsed = parseCliArgs(["--faux"], base);
    expect(parsed.useFaux).toBe(true);
    expect(parsed.autoAcceptCli).toBe(true);
    expect(parsed.approvalMode).toBe("auto-accept");
  });

  it("detects --headless with a prompt", () => {
    const parsed = parseCliArgs(["--headless", "do", "thing"], base);
    expect(parsed.headless).toBe(true);
    expect(parsed.prompt).toBe("do thing");
  });

  it("detects --list-sessions and its -l alias", () => {
    expect(parseCliArgs(["--list-sessions"], base).listSessions).toBe(true);
    expect(parseCliArgs(["-l"], base).listSessions).toBe(true);
  });

  it("detects --chat", () => {
    expect(parseCliArgs(["--chat", "hi"], base).chat).toBe(true);
  });

  it("parses --resume and -r session ids", () => {
    expect(parseCliArgs(["--resume", "sess-1"], base).resumeId).toBe("sess-1");
    expect(parseCliArgs(["-r", "sess-2"], base).resumeId).toBe("sess-2");
  });

  it("leaves resumeId undefined when --resume has no value", () => {
    expect(parseCliArgs(["--resume", "--faux"], base).resumeId).toBeUndefined();
  });

  it("--plan takes precedence over the base mode", () => {
    expect(parseCliArgs(["--plan"], base).approvalMode).toBe("plan");
  });

  it("--plan takes precedence over --auto-accept", () => {
    expect(parseCliArgs(["--plan", "--auto-accept"], base).approvalMode).toBe("plan");
  });

  it("--auto-accept sets auto-accept mode without faux", () => {
    const parsed = parseCliArgs(["--auto-accept"], base);
    expect(parsed.useFaux).toBe(false);
    expect(parsed.autoAcceptCli).toBe(true);
    expect(parsed.approvalMode).toBe("auto-accept");
  });

  it("falls back to the injected base mode when no approval flag is given", () => {
    expect(parseCliArgs(["hello"], () => "plan").approvalMode).toBe("plan");
    expect(parseCliArgs(["hello"], () => "normal").approvalMode).toBe("normal");
  });

  it("separates the resume value from the positional prompt", () => {
    const parsed = parseCliArgs(["--resume", "sess-9", "keep", "going"], base);
    expect(parsed.resumeId).toBe("sess-9");
    // The resume id is a flag value, not part of the prompt.
    expect(parsed.prompt).toBe("sess-9 keep going");
  });
});
