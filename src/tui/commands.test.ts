import { describe, expect, it } from "vitest";
import { processCommand, type CommandContext } from "./commands.js";
import type { ProviderSummary } from "../provider/registry.js";

const ctx: CommandContext = {
  currentModel: "anthropic/claude-sonnet-4",
  currentMode: "normal",
  currentSandbox: "local",
  knownModels: ["anthropic/claude-opus-4", "anthropic/claude-sonnet-4", "openai/gpt-4o"],
};

const providers: ProviderSummary[] = [
  { id: "openrouter", displayName: "OpenRouter", authStrategy: "api-key", active: true, configured: true },
  { id: "anthropic", displayName: "Anthropic", authStrategy: "oauth", active: false, configured: false },
  { id: "regolo", displayName: "Regolo", authStrategy: "api-key", active: false, configured: false },
];

const provCtx: CommandContext = {
  ...ctx,
  currentProvider: "openrouter",
  providers,
  providerConfigFields: (id) => (id === "openrouter" ? [{ key: "apiKey", label: "OpenRouter API key", secret: true }] : []),
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

  it("handles /new", () => {
    expect(processCommand("/new", ctx).type).toBe("new");
  });

  it("handles /sessions", () => {
    expect(processCommand("/sessions", ctx).type).toBe("sessions");
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

  describe("/providers", () => {
    it("lists providers when given no argument", () => {
      const r = processCommand("/providers", provCtx);
      expect(r.type).toBe("info");
      if (r.type === "info") {
        expect(r.message).toContain("openrouter");
        expect(r.message).toContain("anthropic");
        expect(r.message).toContain("[oauth]");
        expect(r.message).toContain("needs setup");
      }
    });

    it("accepts the /provider alias", () => {
      expect(processCommand("/provider", provCtx).type).toBe("info");
    });

    it("switches by explicit id", () => {
      expect(processCommand("/providers anthropic", provCtx)).toMatchObject({
        type: "set-provider",
        provider: "anthropic",
      });
    });

    it("switches by numeric index", () => {
      expect(processCommand("/providers 2", provCtx)).toMatchObject({
        type: "set-provider",
        provider: "anthropic",
      });
    });

    it("warns when switching to an unconfigured provider", () => {
      const r = processCommand("/providers anthropic", provCtx);
      if (r.type === "set-provider") expect(r.message).toMatch(/not configured/);
    });

    it("is a no-op info when already active", () => {
      expect(processCommand("/providers openrouter", provCtx).type).toBe("info");
    });

    it("errors on an unknown provider", () => {
      expect(processCommand("/providers bogus", provCtx).type).toBe("error");
    });

    it("errors on an out-of-range index", () => {
      expect(processCommand("/providers 99", provCtx).type).toBe("error");
    });

    it("lists providers for configure with no argument", () => {
      const r = processCommand("/providers configure", provCtx);
      expect(r.type).toBe("info");
      if (r.type === "info") {
        expect(r.message).toContain("configure a provider");
        expect(r.message).toContain("openrouter");
      }
    });

    it("starts configure flow for an api-key provider", () => {
      expect(processCommand("/providers configure openrouter", provCtx)).toMatchObject({
        type: "configure-provider",
        provider: "openrouter",
        activateOnComplete: false,
      });
    });

    it("starts configure flow by numeric index", () => {
      expect(processCommand("/providers configure 1", provCtx)).toMatchObject({
        type: "configure-provider",
        provider: "openrouter",
      });
    });

    it("reports oauth providers as not yet configurable in the TUI", () => {
      const r = processCommand("/providers configure anthropic", provCtx);
      expect(r.type).toBe("info");
      if (r.type === "info") expect(r.message).toMatch(/OAuth/i);
    });

    it("points unconfigured api-key switches at /providers configure", () => {
      const r = processCommand("/providers regolo", provCtx);
      if (r.type === "set-provider") expect(r.message).toMatch(/\/providers configure regolo/);
    });
  });

  describe("/sandbox", () => {
    it("stays on local when e2b is not configured and cycling", () => {
      const r = processCommand("/sandbox", ctx);
      expect(r.type).toBe("info");
    });

    it("cycles to e2b when an API key is available", () => {
      const prev = process.env.E2B_API_KEY;
      process.env.E2B_API_KEY = "test-key";
      try {
        const r = processCommand("/sandbox", ctx);
        expect(r).toMatchObject({ type: "set-sandbox", kind: "e2b" });
      } finally {
        if (prev === undefined) delete process.env.E2B_API_KEY;
        else process.env.E2B_API_KEY = prev;
      }
    });

    it("sets local explicitly", () => {
      const r = processCommand("/sandbox local", { ...ctx, currentSandbox: "e2b" });
      expect(r).toMatchObject({ type: "set-sandbox", kind: "local" });
    });

    it("errors when e2b is requested without an API key", () => {
      const r = processCommand("/sandbox e2b", ctx);
      expect(r.type).toBe("error");
    });
  });
});
