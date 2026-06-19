import { describe, expect, it } from "vitest";
import { processCommand, type CommandContext } from "./commands.js";
import type { ProviderSummary } from "../provider/registry.js";

const ctx: CommandContext = {
  currentModel: "anthropic/claude-sonnet-4",
  currentMode: "normal",
  knownModels: ["anthropic/claude-opus-4", "anthropic/claude-sonnet-4", "openai/gpt-4o"],
};

const providers: ProviderSummary[] = [
  { id: "openrouter", displayName: "OpenRouter", authStrategy: "api-key", active: true, configured: true },
  { id: "anthropic", displayName: "Anthropic", authStrategy: "api-key-or-oauth", active: false, configured: false },
  { id: "regolo", displayName: "Regolo", authStrategy: "api-key", active: false, configured: false },
];

const provCtx: CommandContext = {
  ...ctx,
  currentProvider: "openrouter",
  providers,
  providerConfigFields: (id) =>
    id === "openrouter"
      ? [{ key: "apiKey", label: "OpenRouter API key", secret: true }]
      : id === "regolo"
        ? [{ key: "apiKey", label: "Regolo AI API key", secret: true, envVar: "REGOLO_API_KEY" }]
        : id === "anthropic"
          ? [{ key: "apiKey", label: "Anthropic API key", secret: true, envVar: "ANTHROPIC_API_KEY" }]
          : [],
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
        expect(r.message).toContain("[api-key|oauth]");
        expect(r.message).toContain("needs setup");
      }
    });

    it("accepts the /provider alias", () => {
      expect(processCommand("/provider", provCtx).type).toBe("info");
    });

    it("switches by explicit id when configured", () => {
      expect(processCommand("/providers regolo", {
        ...provCtx,
        providers: [{ ...providers[2]!, configured: true }],
      })).toMatchObject({
        type: "set-provider",
        provider: "regolo",
      });
    });

    it("opens auth menu for unconfigured anthropic", () => {
      expect(processCommand("/providers anthropic", provCtx)).toMatchObject({
        type: "open-provider-auth",
        provider: "anthropic",
        activateOnComplete: true,
      });
    });

    it("opens auth menu when anthropic is already active", () => {
      expect(processCommand("/providers anthropic", {
        ...provCtx,
        providers: [{ ...providers[1]!, active: true, configured: true }],
        currentProvider: "anthropic",
      })).toMatchObject({
        type: "open-provider-auth",
        provider: "anthropic",
        activateOnComplete: false,
      });
    });

    it("switches configured anthropic by explicit id", () => {
      expect(processCommand("/providers anthropic", {
        ...provCtx,
        providers: [{ ...providers[1]!, configured: true }],
      })).toMatchObject({
        type: "set-provider",
        provider: "anthropic",
      });
    });

    it("opens auth menu by numeric index for unconfigured anthropic", () => {
      expect(processCommand("/providers 2", provCtx)).toMatchObject({
        type: "open-provider-auth",
        provider: "anthropic",
      });
    });

    it("opens auth menu when switching to unconfigured anthropic", () => {
      const r = processCommand("/providers anthropic", provCtx);
      expect(r.type).toBe("open-provider-auth");
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

    it("starts OAuth flow for anthropic", () => {
      expect(processCommand("/providers oauth anthropic", provCtx)).toMatchObject({
        type: "start-oauth",
        provider: "anthropic",
      });
    });

    it("reports oauth-only providers via configure hint", () => {
      const oauthOnly: ProviderSummary[] = [
        { id: "oauth-only", displayName: "OAuth Only", authStrategy: "oauth", active: false, configured: false },
      ];
      const r = processCommand("/providers configure oauth-only", {
        ...provCtx,
        providers: oauthOnly,
      });
      expect(r.type).toBe("info");
      if (r.type === "info") expect(r.message).toMatch(/\/providers oauth oauth-only/);
    });

    it("starts configure flow for anthropic api key", () => {
      expect(processCommand("/providers configure anthropic", provCtx)).toMatchObject({
        type: "configure-provider",
        provider: "anthropic",
      });
    });

    it("points unconfigured api-key switches at /providers configure", () => {
      const r = processCommand("/providers regolo", provCtx);
      if (r.type === "set-provider") expect(r.message).toMatch(/\/providers configure regolo/);
    });

    it("starts configure flow for regolo", () => {
      expect(processCommand("/providers configure regolo", provCtx)).toMatchObject({
        type: "configure-provider",
        provider: "regolo",
        activateOnComplete: false,
      });
    });

    it("auto-swaps model when moving to regolo with an OpenRouter-style model id", () => {
      const r = processCommand("/providers regolo", {
        ...provCtx,
        providers: [{ ...providers[2]!, configured: true }],
      });
      expect(r).toMatchObject({
        type: "set-provider",
        provider: "regolo",
        model: "Llama-3.3-70B-Instruct",
      });
      if (r.type === "set-provider") {
        expect(r.message).toMatch(/model → Llama-3\.3-70B-Instruct/);
      }
    });
  });

  it("rejects /sandbox as an unknown command", () => {
    const r = processCommand("/sandbox", ctx);
    expect(r.type).toBe("error");
    if (r.type === "error") {
      expect(r.message).toMatch(/unknown command/);
    }
  });
});
