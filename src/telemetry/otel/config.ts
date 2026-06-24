/**
 * Resolve the effective OTLP exporter config from `~/.orin/config.json`. Pure —
 * imports no OpenTelemetry packages — so it is safe to call on every session to
 * decide whether the OTel subtree should be lazy-loaded at all.
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

/** Append the traces path to a base OTLP endpoint that doesn't already carry one. */
function tracesEndpoint(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/\/v\d+\/traces$/.test(trimmed)) return trimmed;
  return `${trimmed}/v1/traces`;
}

/**
 * The effective OTLP config from `telemetry.otel` in config.json. `enabled` is
 * auto-derived — true when the config flag is set OR any endpoint is present.
 * Local metrics opt-out does NOT gate this (OTLP has its own switch).
 */
export function resolveOtelConfig(base?: OtelConfig): OtelConfig {
  const cfg = base ?? loadConfig().telemetry.otel;
  const endpoint = cfg.endpoint ? tracesEndpoint(cfg.endpoint) : "";

  return {
    ...cfg,
    endpoint,
    enabled: cfg.enabled || Boolean(endpoint),
  };
}

/**
 * Resolve the OTLP user id for Langfuse grouping. Only called when OTLP export
 * is enabled. Uses `telemetry.otel.userId` from config, or generates and
 * persists a UUID on first export. Returns undefined when export is off.
 */
export function resolveOtelUserId(base?: OtelConfig): string | undefined {
  const cfg = resolveOtelConfig(base);
  if (!cfg.enabled) return undefined;

  const fromConfig = loadConfig().telemetry.otel.userId?.trim();
  if (fromConfig) return fromConfig;

  const generated = randomUUID();
  saveConfig({ telemetry: { otel: { userId: generated } } });
  return generated;
}
