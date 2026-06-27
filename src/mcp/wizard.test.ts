import { describe, expect, it } from "vitest";
import {
  applyWizardStep,
  beginAddWizard,
  beginEditWizard,
  currentWizardStep,
  validateWizardStep,
  wizardComplete,
  wizardToServerConfig,
} from "./wizard.js";

describe("MCP wizard", () => {
  it("walks through add stdio server steps", () => {
    let state = beginAddWizard();

    let step = currentWizardStep(state)!;
    expect(step.id).toBe("name");
    expect(validateWizardStep(state, step, "fs")).toBeNull();
    state = applyWizardStep(state, step, "fs");

    step = currentWizardStep(state)!;
    expect(step.id).toBe("transport");
    state = applyWizardStep(state, step, "stdio");

    step = currentWizardStep(state)!;
    expect(step.id).toBe("command");
    state = applyWizardStep(state, step, "npx");

    step = currentWizardStep(state)!;
    expect(step.id).toBe("args");
    state = applyWizardStep(state, step, "-y @modelcontextprotocol/server-filesystem .");

    expect(wizardComplete(state)).toBe(true);
    expect(wizardToServerConfig(state)).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    });
  });

  it("prefills edit wizard from existing http config", () => {
    const state = beginEditWizard("github", {
      type: "http",
      url: "https://mcp.example.com/github",
    });
    expect(state.transport).toBe("http");
    expect(state.url).toBe("https://mcp.example.com/github");
    expect(currentWizardStep(state)?.id).toBe("transport");
  });

  it("rejects invalid server names", () => {
    const state = beginAddWizard();
    const step = currentWizardStep(state)!;
    expect(validateWizardStep(state, step, "bad name")).toMatch(/name must/);
  });
});
