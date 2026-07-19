import { APICallError } from "@ai-sdk/provider";
import { RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { isCriticalSystemError, isRateLimitError } from "./system-error.js";

describe("isCriticalSystemError", () => {
  it("flags disk-full and other unrecoverable resource errors", () => {
    for (const code of ["ENOSPC", "EDQUOT", "EROFS", "EMFILE", "ENFILE", "ENOMEM", "EIO"]) {
      const err = Object.assign(new Error(`failed: ${code}`), { code });
      expect(isCriticalSystemError(err)).toBe(true);
    }
  });

  it("flags network partition errors", () => {
    for (const code of ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET", "ENETUNREACH"]) {
      const err = Object.assign(new Error(`failed: ${code}`), { code });
      expect(isCriticalSystemError(err)).toBe(true);
    }
  });

  it("flags non-retryable HTTP auth and billing errors", () => {
    for (const statusCode of [401, 402, 403]) {
      const err = Object.assign(new Error(`request failed: HTTP ${statusCode}`), { statusCode });
      expect(isCriticalSystemError(err)).toBe(true);
    }
  });

  it("flags APICallError auth failures", () => {
    const err = new APICallError({
      message: "Error",
      url: "https://api.example.com/v1/messages",
      requestBodyValues: {},
      statusCode: 401,
      responseBody: JSON.stringify({ error: { message: "invalid api key" } }),
    });
    expect(isCriticalSystemError(err)).toBe(true);
  });

  it("flags auth failures wrapped in RetryError", () => {
    const apiErr = new APICallError({
      message: "Error",
      url: "https://api.example.com/v1/messages",
      requestBodyValues: {},
      statusCode: 403,
      responseBody: JSON.stringify({ error: { message: "forbidden" } }),
    });
    const retry = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [apiErr, apiErr, apiErr],
    });
    expect(isCriticalSystemError(retry)).toBe(true);
  });

  it("does not flag recoverable, path-specific errors", () => {
    for (const code of ["EACCES", "EPERM", "ENOENT", "EEXIST", "EISDIR"]) {
      const err = Object.assign(new Error(`failed: ${code}`), { code });
      expect(isCriticalSystemError(err)).toBe(false);
    }
  });

  it("does not flag rate limits as critical", () => {
    const err = Object.assign(new Error("rate limited: HTTP 429"), { statusCode: 429 });
    expect(isCriticalSystemError(err)).toBe(false);
  });

  it("walks the cause chain", () => {
    const root = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const wrapped = new Error("write failed", { cause: root });
    expect(isCriticalSystemError(wrapped)).toBe(true);
  });

  it("returns false for plain errors and non-errors", () => {
    expect(isCriticalSystemError(new Error("boom"))).toBe(false);
    expect(isCriticalSystemError("just a string")).toBe(false);
    expect(isCriticalSystemError(undefined)).toBe(false);
  });
});

describe("isRateLimitError", () => {
  it("detects HTTP 429 status codes", () => {
    const err = Object.assign(new Error("too many requests"), { statusCode: 429 });
    expect(isRateLimitError(err)).toBe(true);
  });

  it("detects APICallError rate limits", () => {
    const err = new APICallError({
      message: "Error",
      url: "https://api.example.com/v1/messages",
      requestBodyValues: {},
      statusCode: 429,
      responseBody: JSON.stringify({ error: { message: "rate limit exceeded" } }),
    });
    expect(isRateLimitError(err)).toBe(true);
  });

  it("detects rate limit messages", () => {
    expect(isRateLimitError(new Error("rate limit exceeded"))).toBe(true);
    expect(isRateLimitError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
  });

  it("does not flag auth failures as rate limits", () => {
    const err = Object.assign(new Error("unauthorized"), { statusCode: 401 });
    expect(isRateLimitError(err)).toBe(false);
  });
});
