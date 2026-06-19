/**
 * AgentEvent → OTel span lifecycle consumer (issue 5/8). Plugged into
 * `installTelemetry`: session_start/end open and close the trace root, paired
 * `llm_start`/`assistant_message` become generation spans, and tool_start/end
 * become tool spans.
 *
 * Concurrency: `hooks.emit` dispatches observers via `Promise.resolve().then()`
 * (registry.ts), which detaches async context, and tools run under
 * `Promise.all`. So this consumer does NOT use `context.with()` — it keeps
 * explicit `Map<id, Span>` tables and parents every span on an explicit
 * `Context` derived from the session root. A missing parent never drops a span:
 * it falls back to the root (or ROOT_CONTEXT).
 *
 * The OTel SDK loads asynchronously, but events can arrive before it is ready,
 * so each handler captures a wall-clock timestamp and is queued; the queue is
 * drained in order once the runtime resolves, preserving span timing and
 * parent-before-child ordering.
 */
import type { Span } from "@opentelemetry/api";
import type { ModelPricing } from "../../config/config.js";
import type { AgentEvent } from "../../agent/events.js";
import type { AssistantMessage } from "../../provider/types.js";
import { calcCost } from "../cost.js";
import { resolveOtelConfig, type OtelConfig } from "./config.js";
import { loadOtelRuntime, type OtelRuntime, type ProviderDeps } from "./provider.js";
import {
  llmRequestAttributes,
  llmResponseAttributes,
  llmSpanName,
  toolEndAttributes,
  toolStartAttributes,
} from "./semconv.js";

export interface OtelConsumerOptions {
  sessionId: string;
  providerId?: string;
  pricing: Record<string, ModelPricing>;
  /** Pre-resolved config (defaults to `resolveOtelConfig()`). */
  cfg?: OtelConfig;
  /** Provider injection for tests (InMemory exporter). */
  deps?: ProviderDeps;
}

/** The lifecycle surface `installTelemetry` drives. */
export interface OtelSpanConsumer {
  startSession(attributes?: Record<string, string>): void;
  handleEvent(event: AgentEvent): void;
  endSession(reason: string): void;
  /** Await SDK init, end any open spans, and flush the exporter. Best-effort. */
  flush(): Promise<void>;
}

/**
 * Build the consumer, or `undefined` when OTLP export is disabled. Synchronous
 * so `installTelemetry` stays sync; the SDK import is kicked off in the
 * background and events buffer until it lands.
 */
export function createOtelSpanConsumer(opts: OtelConsumerOptions): OtelSpanConsumer | undefined {
  const cfg = resolveOtelConfig(opts.cfg);
  if (!cfg.enabled) return undefined;
  return new SpanConsumer(cfg, opts);
}

class SpanConsumer implements OtelSpanConsumer {
  private runtime: OtelRuntime | undefined;
  private readonly initPromise: Promise<void>;
  private queue: Array<(rt: OtelRuntime) => void> = [];

  private root: Span | undefined;
  private readonly llmSpans = new Map<string, Span>();
  private readonly toolSpans = new Map<string, Span>();

  constructor(
    private readonly cfg: OtelConfig,
    private readonly opts: OtelConsumerOptions,
  ) {
    this.initPromise = this.init();
  }

  private async init(): Promise<void> {
    const runtime = await loadOtelRuntime(this.cfg, this.opts.deps);
    if (!runtime) {
      // SDK unavailable — drop buffered work and become a no-op.
      this.queue = [];
      return;
    }
    this.runtime = runtime;
    const pending = this.queue;
    this.queue = [];
    for (const fn of pending) {
      try {
        fn(runtime);
      } catch {
        // A span-building failure must never break the loop.
      }
    }
  }

  /** Run now if the runtime is ready, otherwise buffer for the post-init drain. */
  private apply(fn: (rt: OtelRuntime) => void): void {
    if (this.runtime) {
      try {
        fn(this.runtime);
      } catch {
        // best-effort
      }
    } else {
      this.queue.push(fn);
    }
  }

  /** Parent context for a child span: the session root, or ROOT when absent. */
  private parentContext(rt: OtelRuntime) {
    return this.root ? rt.api.trace.setSpan(rt.api.ROOT_CONTEXT, this.root) : rt.api.ROOT_CONTEXT;
  }

  startSession(attributes: Record<string, string> = {}): void {
    const startTime = Date.now();
    this.apply((rt) => {
      this.root = rt.tracer.startSpan(
        `session ${this.opts.sessionId}`,
        {
          startTime,
          kind: rt.api.SpanKind.INTERNAL,
          attributes: { "orin.session.id": this.opts.sessionId, ...attributes },
        },
        rt.api.ROOT_CONTEXT,
      );
    });
  }

  handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "llm_start":
        return this.onLlmStart(event.id, event.model);
      case "assistant_message":
        return this.onAssistantMessage(event.id, event.message);
      case "tool_start":
        return this.onToolStart(event.id, event.name);
      case "tool_end":
        return this.onToolEnd(event.id, event.output, event.isError === true);
      default:
        return;
    }
  }

  private onLlmStart(id: string, model: string): void {
    const startTime = Date.now();
    this.apply((rt) => {
      const span = rt.tracer.startSpan(
        llmSpanName(model),
        {
          startTime,
          kind: rt.api.SpanKind.CLIENT,
          attributes: llmRequestAttributes({ requestModel: model, providerId: this.opts.providerId }),
        },
        this.parentContext(rt),
      );
      this.llmSpans.set(id, span);
    });
  }

  private onAssistantMessage(id: string, message: AssistantMessage): void {
    const endTime = Date.now();
    this.apply(() => {
      const span = this.llmSpans.get(id);
      if (!span) return;
      this.llmSpans.delete(id);
      const finishReasons = message.stopReason ? [message.stopReason] : undefined;
      if (message.usage) {
        const cost = calcCost(message.model, message.usage, this.opts.pricing, this.opts.providerId);
        span.setAttributes(llmResponseAttributes({ responseModel: message.model, cost, finishReasons }));
      } else {
        span.setAttribute("gen_ai.response.model", message.model);
        if (finishReasons) span.setAttribute("gen_ai.response.finish_reasons", finishReasons);
      }
      span.end(endTime);
    });
  }

  private onToolStart(id: string, name: string): void {
    const startTime = Date.now();
    this.apply((rt) => {
      const span = rt.tracer.startSpan(
        name,
        {
          startTime,
          kind: rt.api.SpanKind.INTERNAL,
          attributes: toolStartAttributes({ name, callId: id }),
        },
        this.parentContext(rt),
      );
      this.toolSpans.set(id, span);
    });
  }

  private onToolEnd(id: string, output: string, isError: boolean): void {
    const endTime = Date.now();
    this.apply((rt) => {
      const span = this.toolSpans.get(id);
      if (!span) return;
      this.toolSpans.delete(id);
      span.setAttributes(toolEndAttributes({ ok: !isError, output }));
      if (isError) {
        span.setStatus({ code: rt.api.SpanStatusCode.ERROR });
      }
      span.end(endTime);
    });
  }

  endSession(reason: string): void {
    const endTime = Date.now();
    this.apply((rt) => {
      // Close any spans still open (interrupted call, abandoned tool).
      for (const span of this.llmSpans.values()) span.end(endTime);
      for (const span of this.toolSpans.values()) span.end(endTime);
      this.llmSpans.clear();
      this.toolSpans.clear();
      if (this.root) {
        if (reason === "error") this.root.setStatus({ code: rt.api.SpanStatusCode.ERROR });
        this.root.end(endTime);
        this.root = undefined;
      }
    });
  }

  async flush(): Promise<void> {
    await this.initPromise;
    if (this.runtime) await this.runtime.forceFlush();
  }
}
