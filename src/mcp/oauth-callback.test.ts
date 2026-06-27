import { describe, expect, it } from "vitest";
import { startOAuthCallbackServer } from "./oauth-callback.js";

describe("startOAuthCallbackServer", () => {
  it("captures authorization code from callback URL", async () => {
    const server = await startOAuthCallbackServer();
    const port = server.redirectUrl.port;
    const res = await fetch(
      `http://127.0.0.1:${port}/callback?code=abc123&state=xyz`,
    );
    expect(res.ok).toBe(true);
    await expect(server.waitForCode).resolves.toEqual({ code: "abc123", state: "xyz" });
    server.close();
  });
});
