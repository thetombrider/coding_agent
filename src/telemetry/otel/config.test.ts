import { afterEach, describe, expect, it } from "vitest";
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

const OTEL_ENV = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_SERVICE_NAME",
  "OTEL_TRACES_SAMPLER",
  "OTEL_TRACES_SAMPLER_ARG",
];

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
  afterEach(() => {
    for (const key of OTEL_ENV) delete process.env[key];
  });

  it("stays disabled with no endpoint and no env", () => {
    expect(resolveOtelConfig(base).enabled).toBe(false);
  });

  it("auto-enables when the config carries an endpoint", () => {
    const cfg = resolveOtelConfig({ ...base, endpoint: "https://collector/v1/traces" });
    expect(cfg.enabled).toBe(true);
    expect(cfg.endpoint).toBe("https://collector/v1/traces");
  });

  it("appends /v1/traces to a bare base endpoint from env and auto-enables", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://collector:4318";
    const cfg = resolveOtelConfig(base);
    expect(cfg.enabled).toBe(true);
    expect(cfg.endpoint).toBe("https://collector:4318/v1/traces");
  });

  it("prefers the traces-specific endpoint env and uses it verbatim", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://base:4318";
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "https://traces/otel/v1/traces";
    expect(resolveOtelConfig(base).endpoint).toBe("https://traces/otel/v1/traces");
  });

  it("merges header, protocol, and service-name env (env wins)", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://c";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Bearer t";
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
    process.env.OTEL_SERVICE_NAME = "my-agent";
    const cfg = resolveOtelConfig({ ...base, headers: { keep: "1" }, serviceName: "orin" });
    expect(cfg.headers).toEqual({ keep: "1", Authorization: "Bearer t" });
    expect(cfg.protocol).toBe("grpc");
    expect(cfg.serviceName).toBe("my-agent");
  });

  it("honors the traces sampler env", () => {
    process.env.OTEL_TRACES_SAMPLER = "traceidratio";
    process.env.OTEL_TRACES_SAMPLER_ARG = "0.25";
    expect(resolveOtelConfig(base).sampleRatio).toBe(0.25);

    process.env.OTEL_TRACES_SAMPLER = "always_off";
    expect(resolveOtelConfig(base).sampleRatio).toBe(0);
  });
});
