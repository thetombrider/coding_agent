import { describe, expect, it } from "vitest";
import { processCommand, type CommandContext } from "./commands.js";

const ctx: CommandContext = {
  currentModel: "anthropic/claude-sonnet-4",
  currentMode: "normal",
  knownModels: ["anthropic/claude-opus-4", "anthropic/claude-sonnet-4", "openai/gpt-4o"],
};

describe("processCommand", () => {
  it("treats non-slash input as a normal turn", () => {
    expect(processCommand("hello world", ctx)).toEqual({ type: "not-command" });
  });

  it("handles /exit and /quit", () => {
    expect(processCommand("/exit", ctx).type).toBe("exit");
    expect(processCommand("/quit", ctx).type).toBe("exit");
  });

  it("handles /clear", () => {
    expect(processCommand("/clear", ctx).type).toBe("clear");
  });

  it("reports unknown commands", () => {
    const r = processCommand("/bogus", ctx);
    expect(r.type).toBe("error");
  });

  describe("/mode", () => {
    it("cycles when given no argument", () => {
      const r = processCommand("/mode", ctx);
      expect(r).toMatchObject({ type: "set-mode", mode: "auto-accept" });
    });

    it("wraps the cycle from plan back to normal", () => {
      const r = processCommand("/mode", { ...ctx, currentMode: "plan" });
      expect(r).toMatchObject({ type: "set-mode", mode: "normal" });
    });

    it("sets a named mode, including the 'allow all' alias", () => {
      expect(processCommand("/mode plan", ctx)).toMatchObject({ type: "set-mode", mode: "plan" });
      expect(processCommand("/mode allow all", ctx)).toMatchObject({
        type: "set-mode",
        mode: "auto-accept",
      });
    });

    it("is a no-op info when already in that mode", () => {
      expect(processCommand("/mode normal", ctx).type).toBe("info");
    });

    it("errors on an unknown mode name", () => {
      expect(processCommand("/mode turbo", ctx).type).toBe("error");
    });
  });

  describe("/model", () => {
    it("lists models when given no argument", () => {
      const r = processCommand("/model", ctx);
      expect(r.type).toBe("info");
      if (r.type === "info") expect(r.message).toContain("openai/gpt-4o");
    });

    it("sets a model by explicit id", () => {
      expect(processCommand("/model openai/gpt-4o", ctx)).toMatchObject({
        type: "set-model",
        model: "openai/gpt-4o",
      });
    });

    it("sets a model by numeric index", () => {
      expect(processCommand("/model 1", ctx)).toMatchObject({
        type: "set-model",
        model: "anthropic/claude-opus-4",
      });
    });

    it("errors on an out-of-range index", () => {
      expect(processCommand("/model 99", ctx).type).toBe("error");
    });

    it("is a no-op info when already using the model", () => {
      expect(processCommand("/model anthropic/claude-sonnet-4", ctx).type).toBe("info");
    });
  });
});
