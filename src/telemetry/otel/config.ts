/**
 * Resolve the effective OTLP exporter config from the config file overlaid with
 * standard `OTEL_*` environment variables (env wins). Pure — imports no
 * OpenTelemetry packages — so it is safe to call on every session to decide
 * whether the OTel subtree should be lazy-loaded at all.
 */
import { randomUUID } from "node:crypto";
import { loadConfig, saveConfig, type OtelConfig } from "../../config/config.js";

export type { OtelConfig };

/** Parse `k1=v1,k2=v2` (the OTLP headers env format) into a record. */
export function parseOtlpHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

/**
 * Resolve the sample ratio from `OTEL_TRACES_SAMPLER`/`OTEL_TRACES_SAMPLER_ARG`,
 * falling back to the config ratio. `always_off`→0, `always_on`→1, the
 * ratio-based samplers use the arg.
 */
function resolveSampleRatio(fallback: number): number {
  const sampler = process.env.OTEL_TRACES_SAMPLER?.trim().toLowerCase();
  if (!sampler) return fallback;
  if (sampler === "always_off") return 0;
  if (sampler === "always_on" || sampler === "parentbased_always_on") return 1;
  if (sampler.includes("traceidratio")) {
    const arg = Number(process.env.OTEL_TRACES_SAMPLER_ARG);
    if (Number.isFinite(arg)) return Math.min(1, Math.max(0, arg));
  }
  return fallback;
}

/** Append the traces path to a base OTLP endpoint that doesn't already carry one. */
function tracesEndpoint(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/\/v\d+\/traces$/.test(trimmed)) return trimmed;
  return `${trimmed}/v1/traces`;
}

/**
 * The effective OTLP config: config-file defaults overlaid with `OTEL_*` env.
 * `enabled` is auto-derived — true when the config flag is set OR any endpoint
 * is present. `ORIN_NO_TELEMETRY` deliberately does NOT gate this (OTLP has its
 * own switch).
 */
export function resolveOtelConfig(base?: OtelConfig): OtelConfig {
  const cfg = base ?? loadConfig().telemetry.otel;

  // Traces-specific endpoint env wins; a bare base endpoint gets `/v1/traces`.
  const tracesEnv = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const baseEnv = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const endpoint = tracesEnv
    ? tracesEnv
    : baseEnv
      ? tracesEndpoint(baseEnv)
      : cfg.endpoint;

  const headersEnv = process.env.OTEL_EXPORTER_OTLP_HEADERS?.trim();
  const headers = headersEnv ? { ...cfg.headers, ...parseOtlpHeaders(headersEnv) } : cfg.headers;

  const protocol = process.env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim() || cfg.protocol;
  const serviceName = process.env.OTEL_SERVICE_NAME?.trim() || cfg.serviceName;
  const sampleRatio = resolveSampleRatio(cfg.sampleRatio);

  return {
    ...cfg,
    endpoint,
    headers,
    protocol,
    serviceName,
    sampleRatio,
    enabled: cfg.enabled || Boolean(endpoint),
  };
}

/**
 * Resolve the OTLP user id for Langfuse grouping. Only called when OTLP export
 * is enabled. Order: `OTEL_USER_ID` env → `telemetry.otel.userId` config →
 * generated UUID persisted to config. Returns undefined when export is off.
 */
export function resolveOtelUserId(base?: OtelConfig): string | undefined {
  const cfg = resolveOtelConfig(base);
  if (!cfg.enabled) return undefined;

  const fromEnv = process.env.OTEL_USER_ID?.trim();
  if (fromEnv) return fromEnv;

  const fromConfig = loadConfig().telemetry.otel.userId?.trim();
  if (fromConfig) return fromConfig;

  const generated = randomUUID();
  saveConfig({ telemetry: { otel: { userId: generated } } });
  return generated;
}
