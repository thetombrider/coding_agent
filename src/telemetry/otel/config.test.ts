import { describe, expect, it } from "vitest";
import { parseOtlpHeaders, resolveOtelConfig, type OtelConfig } from "./config.js";

const base: OtelConfig = {
  enabled: false,
  endpoint: "",
  protocol: "http/protobuf",
  headers: {},
  serviceName: "orin",
  semconv: "genai",
  captureContent: false,
  sampleRatio: 1,
};

describe("parseOtlpHeaders", () => {
  it("parses comma-separated key=value pairs", () => {
    expect(parseOtlpHeaders("Authorization=Bearer x,X-Scope=team")).toEqual({
      Authorization: "Bearer x",
      "X-Scope": "team",
    });
  });

  it("keeps `=` inside values and skips malformed entries", () => {
    expect(parseOtlpHeaders("a=b=c, ,bad")).toEqual({ a: "b=c" });
  });
});

describe("resolveOtelConfig", () => {
  it("stays disabled with no endpoint", () => {
    expect(resolveOtelConfig(base).enabled).toBe(false);
  });

  it("auto-enables when the config carries a full traces endpoint", () => {
    const cfg = resolveOtelConfig({ ...base, endpoint: "https://collector/v1/traces" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.endpoint).toBe("https://collector/v1/traces");
  });

  it("appends /v1/traces to a bare base endpoint and auto-enables", () => {
    const cfg = resolveOtelConfig({ ...base, endpoint: "https://collector:4318" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.endpoint).toBe("https://collector:4318/v1/traces");
  });

  it("preserves headers, protocol, service name, and sample ratio from config", () => {
    const cfg = resolveOtelConfig({
      ...base,
      endpoint: "https://c/v1/traces",
      headers: { keep: "1", Authorization: "Bearer t" },
      protocol: "grpc",
      serviceName: "my-agent",
      sampleRatio: 0.25,
      captureContent: true,
    });
    expect(cfg.headers).toEqual({ keep: "1", Authorization: "Bearer t" });
    expect(cfg.protocol).toBe("grpc");
    expect(cfg.serviceName).toBe("my-agent");
    expect(cfg.sampleRatio).toBe(0.25);
    expect(cfg.captureContent).toBe(true);
  });
});
