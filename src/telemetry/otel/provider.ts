/**
 * Lazy OpenTelemetry runtime: the OTel npm subtree is `import()`-ed only here,
 * the first time an OTLP-enabled session is installed, so a disabled config has
 * zero startup or bundle cost. A single tracer provider is shared per process
 * (sessions are spans under it); tests inject their own provider for isolation.
 */
import { createRequire } from "node:module";
import type { OtelConfig } from "./config.js";

/** Minimal slice of the `@opentelemetry/api` surface the exporter relies on. */
export interface OtelApi {
  trace: typeof import("@opentelemetry/api").trace;
  ROOT_CONTEXT: typeof import("@opentelemetry/api").ROOT_CONTEXT;
  SpanKind: typeof import("@opentelemetry/api").SpanKind;
  SpanStatusCode: typeof import("@opentelemetry/api").SpanStatusCode;
}

export interface OtelRuntime {
  api: OtelApi;
  tracer: import("@opentelemetry/api").Tracer;
  /** Flush pending spans through the exporter. Best-effort. */
  forceFlush(): Promise<void>;
}

/** Dependency injection seam for tests — supply a provider wired to InMemory. */
export interface ProviderDeps {
  tracerProvider?: import("@opentelemetry/sdk-trace-node").NodeTracerProvider;
}

/** Read this package's version for `service.version`, without bundling package.json. */
function serviceVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require("../../../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

let sharedProvider: import("@opentelemetry/sdk-trace-node").NodeTracerProvider | undefined;
let flushRegistered = false;

async function buildSharedProvider(cfg: OtelConfig) {
  const [{ NodeTracerProvider, BatchSpanProcessor, TraceIdRatioBasedSampler }, { resourceFromAttributes }, { OTLPTraceExporter }, semconv] =
    await Promise.all([
      import("@opentelemetry/sdk-trace-node"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/semantic-conventions"),
    ]);

  const exporter = new OTLPTraceExporter({
    url: cfg.endpoint || undefined,
    headers: cfg.headers,
  });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [semconv.ATTR_SERVICE_NAME]: cfg.serviceName,
      [semconv.ATTR_SERVICE_VERSION]: serviceVersion(),
    }),
    sampler: new TraceIdRatioBasedSampler(cfg.sampleRatio),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  if (!flushRegistered) {
    flushRegistered = true;
    // Drain the batch processor on a clean exit so the last session's spans ship.
    process.once("beforeExit", () => {
      void provider.forceFlush().catch(() => {});
    });
  }
  return provider;
}

/**
 * Load the OTel runtime (api refs + a tracer + flush). Returns `undefined` if
 * the subtree can't be loaded — a missing/broken OTel install must never break
 * the agent. Pass `deps.tracerProvider` to bypass the shared OTLP provider.
 */
export async function loadOtelRuntime(
  cfg: OtelConfig,
  deps: ProviderDeps = {},
): Promise<OtelRuntime | undefined> {
  try {
    const api = await import("@opentelemetry/api");
    const provider = deps.tracerProvider ?? sharedProvider ?? (sharedProvider = await buildSharedProvider(cfg));
    return {
      api: {
        trace: api.trace,
        ROOT_CONTEXT: api.ROOT_CONTEXT,
        SpanKind: api.SpanKind,
        SpanStatusCode: api.SpanStatusCode,
      },
      tracer: provider.getTracer(cfg.serviceName),
      forceFlush: () => provider.forceFlush().catch(() => {}),
    };
  } catch {
    return undefined;
  }
}

/** Test hook: drop the shared provider so the next load rebuilds it. */
export function resetSharedProviderForTests(): void {
  sharedProvider = undefined;
  flushRegistered = false;
}
