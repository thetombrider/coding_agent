import { APICallError } from "@ai-sdk/provider";
import { RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { ANTHROPIC_OAUTH_HINT, formatStreamError } from "./format-stream-error.js";

describe("formatStreamError", () => {
  it("extracts Anthropic error JSON from APICallError", () => {
    const err = new APICallError({
      message: "Error",
      url: "https://api.anthropic.com/v1/messages",
      requestBodyValues: {},
      statusCode: 401,
      responseBody: JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "OAuth authentication is currently not supported." },
      }),
    });
    expect(formatStreamError(err)).toContain("OAuth authentication is currently not supported");
    expect(formatStreamError(err)).toContain("HTTP 401");
  });

  it("unwraps RetryError and adds OAuth guidance when requested", () => {
    const apiErr = new APICallError({
      message: "Error",
      url: "https://api.anthropic.com/v1/messages",
      requestBodyValues: {},
      statusCode: 401,
      responseBody: JSON.stringify({
        error: { type: "authentication_error", message: "invalid bearer token" },
      }),
    });
    const retry = new RetryError({
      message: "Failed after 3 attempts. Last error: Error",
      reason: "maxRetriesExceeded",
      errors: [apiErr, apiErr, apiErr],
    });
    const formatted = formatStreamError(retry, { anthropicOAuth: true });
    expect(formatted).toContain("invalid bearer token");
    expect(formatted).toContain("after 3 attempts");
    expect(formatted).toContain(ANTHROPIC_OAUTH_HINT);
  });
});
