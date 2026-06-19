import { APICallError } from "@ai-sdk/provider";
import { RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { formatStreamError } from "./format-stream-error.js";

describe("formatStreamError", () => {
  it("extracts Anthropic error JSON from APICallError", () => {
    const err = new APICallError({
      message: "Error",
      url: "https://api.anthropic.com/v1/messages",
      requestBodyValues: {},
      statusCode: 401,
      responseBody: JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      }),
    });
    expect(formatStreamError(err)).toContain("invalid x-api-key");
    expect(formatStreamError(err)).toContain("HTTP 401");
  });

  it("unwraps RetryError and preserves attempt count", () => {
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
    const formatted = formatStreamError(retry);
    expect(formatted).toContain("invalid bearer token");
    expect(formatted).toContain("after 3 attempts");
  });
});
