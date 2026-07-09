/**
 * AgentEvent → OTel span lifecycle consumer (issue 5/8, revised #113). Plugged
 * into `installTelemetry`: each `turn_start`/`loop_end` pair opens and closes a
 * per-Q&A trace root; paired `llm_start`/`assistant_message` become generation
 * spans, and tool_start/end become tool spans. Orin sessions map to Langfuse
 * Sessions via `session.id` / `langfuse.session.id` on every trace root — not a
 * span.
 *
 * Subagents (issue 6/8): a `subagent_start` opens a `subagent:{agent}` span
 * parented on the in-flight `task` tool span (else the turn root), and any
 * LLM/tool event carrying a `subagentId` nests under that span. Concurrent
 * subagents stay isolated by `subagentId`, so fan-out (#37) doesn't
 * cross-attribute.
 *
 * Concurrency: `hooks.emit` dispatches observers via `Promise.resolve().then()`
 * (registry.ts), which detaches async context, and tools run under
 * `Promise.all`. So this consumer does NOT use `context.with()` — it keeps
 * explicit `Map<id, Span>` tables and parents every span on an explicit
 * `Context` derived from the turn root. A missing parent never drops a span:
 * it falls back to the root (or ROOT_CONTEXT).
 *
 * The OTel SDK loads asynchronously, but events can arrive before it is ready,
 * so each handler captures a wall-clock timestamp and is queued; the queue is
 * drained in order once the runtime resolves, preserving span timing and
 * parent-before-child ordering.
 */
import type { Span } from "@opentelemetry/api";
import type { ModelPricing } from "../../config/config.js";
import type { AgentEvent, LlmRequestSnapshot } from "../../agent/events.js";
import type { AssistantMessage } from "../../provider/types.js";
import { calcCost } from "../cost.js";
import { resolveOtelConfig, resolveOtelUserId, type OtelConfig } from "./config.js";
import { loadOtelRuntime, type OtelRuntime, type ProviderDeps } from "./provider.js";
import {
  llmInputAttributes,
  llmOutputAttributes,
  llmRequestAttributes,
  llmResponseAttributes,
  llmSpanName,
  SPAN_KIND_ATTRIBUTE,
  SpanKindValue,
  subagentEndAttributes,
  subagentInputAttributes,
  subagentOutputAttributes,
  subagentSpanName,
  subagentStartAttributes,
  toolEndAttributes,
  toolInputAttributes,
  toolOutputAttributes,
  toolStartAttributes,
  traceName,
  ratelResolutionAttributes,
  ratelGatewayToolAttributes,
} from "./semconv.js";
import { isRatelGatewayTool } from "../../ratel/telemetry.js";

/** Tool name that spawns a subagent — its in-flight span parents the subagent. */
const TASK_TOOL_NAME = "task";

export interface OtelConsumerOptions {
  sessionId: string;
  providerId?: string;
  pricing: Record<string, ModelPricing>;
  /** Pre-resolved config (defaults to `resolveOtelConfig()`). */
  cfg?: OtelConfig;
  /** Pre-resolved user id (defaults to `resolveOtelUserId()`). */
  userId?: string;
  /** Provider injection for tests (InMemory exporter). */
  deps?: ProviderDeps;
}

/** The lifecycle surface `installTelemetry` drives. */
export interface OtelSpanConsumer {
  handleEvent(event: AgentEvent): void;
  /** Close any open turn trace without flushing (e.g. dispose mid-turn). */
  endOpenTurn(reason: string): void;
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
  const userId =
    opts.userId !== undefined ? opts.userId.trim() || undefined : resolveOtelUserId(cfg);
  return new SpanConsumer(cfg, { ...opts, userId });
}

class SpanConsumer implements OtelSpanConsumer {
  private runtime: OtelRuntime | undefined;
  private readonly initPromise: Promise<void>;
  private queue: Array<(rt: OtelRuntime) => void> = [];

  private turnRoot: Span | undefined;
  private readonly llmSpans = new Map<string, Span>();
  private readonly toolSpans = new Map<string, Span>();
  /** subagentId → open subagent span (6/8). Child LLM/tool spans parent here. */
  private readonly subagentSpans = new Map<string, Span>();
  /**
   * Call ids of in-flight `task` tool spans not yet claimed by a subagent span,
   * oldest first. `subagent_start` fires synchronously right after its `task`
   * tool_start (task.ts), so the oldest unclaimed entry is the parent — this
   * holds under parallel fan-out (#37) where starts interleave per task.
   */
  private pendingTaskSpans: string[] = [];

  constructor(
    private readonly cfg: OtelConfig,
    private readonly opts: OtelConsumerOptions & { userId?: string },
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

  /** Parent context for a child span: the turn root, or ROOT when absent. */
  private parentContext(rt: OtelRuntime) {
    return this.turnRoot
      ? rt.api.trace.setSpan(rt.api.ROOT_CONTEXT, this.turnRoot)
      : rt.api.ROOT_CONTEXT;
  }

  /**
   * Parent context for an LLM/tool span: the subagent span keyed by
   * `subagentId` when present and open (sibling isolation under parallel
   * fan-out), else the turn root.
   */
  private childParentContext(rt: OtelRuntime, subagentId?: string) {
    if (subagentId) {
      const span = this.subagentSpans.get(subagentId);
      if (span) return rt.api.trace.setSpan(rt.api.ROOT_CONTEXT, span);
    }
    return this.parentContext(rt);
  }

  private turnRootAttributes(): Record<string, string> {
    const attrs: Record<string, string> = {};
    const sessionId = this.opts.sessionId?.trim();
    if (sessionId) {
      attrs["session.id"] = sessionId;
      attrs["langfuse.session.id"] = sessionId;
    }
    if (this.opts.userId) {
      attrs["user.id"] = this.opts.userId;
      attrs["langfuse.user.id"] = this.opts.userId;
    }
    return attrs;
  }

  handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "turn_start":
        return this.onTurnStart(event.id, event.firstUserText);
      case "loop_end":
        return this.onLoopEnd(event.reason);
      case "llm_start":
        return this.onLlmStart(event.id, event.model, event.subagentId, event.request);
      case "assistant_message":
        return this.onAssistantMessage(event.id, event.message);
      case "tool_start":
        return this.onToolStart(event.id, event.name, event.subagentId, event.args);
      case "tool_end":
        return this.onToolEnd(event.id, event.output, event.isError === true);
      case "subagent_start":
        return this.onSubagentStart(
          event.id,
          event.agent,
          event.isolation,
          event.model,
          event.prompt,
        );
      case "subagent_end":
        return this.onSubagentEnd(event.id, event.turns, event.summary);
      default:
        return;
    }
  }

  private onTurnStart(turnId: string, firstUserText?: string): void {
    const startTime = Date.now();
    // Name the trace from the turn's first user message so the Langfuse list is
    // scannable; `orin.turn.id` stays the stable identifier. The name is a short
    // truncated label — content bodies remain gated behind captureContent.
    const name = traceName(firstUserText);
    this.apply((rt) => {
      this.turnRoot = rt.tracer.startSpan(
        name,
        {
          startTime,
          kind: rt.api.SpanKind.INTERNAL,
          attributes: {
            [SPAN_KIND_ATTRIBUTE]: SpanKindValue.AGENT,
            "orin.turn.id": turnId,
            ...this.turnRootAttributes(),
          },
        },
        rt.api.ROOT_CONTEXT,
      );
    });
  }

  private onLoopEnd(reason: "complete" | "terminate" | "error" | "cancelled"): void {
    const endTime = Date.now();
    this.apply((rt) => {
      this.closeOpenChildren(endTime);
      if (this.turnRoot) {
        if (reason === "error") this.turnRoot.setStatus({ code: rt.api.SpanStatusCode.ERROR });
        this.turnRoot.end(endTime);
        this.turnRoot = undefined;
      }
      void this.runtime?.forceFlush();
    });
  }

  endOpenTurn(reason: string): void {
    const endTime = Date.now();
    this.apply((rt) => {
      this.closeOpenChildren(endTime);
      if (this.turnRoot) {
        if (reason === "error") this.turnRoot.setStatus({ code: rt.api.SpanStatusCode.ERROR });
        this.turnRoot.end(endTime);
        this.turnRoot = undefined;
      }
    });
  }

  private closeOpenChildren(endTime: number): void {
    for (const span of this.llmSpans.values()) span.end(endTime);
    for (const span of this.toolSpans.values()) span.end(endTime);
    for (const span of this.subagentSpans.values()) span.end(endTime);
    this.llmSpans.clear();
    this.toolSpans.clear();
    this.subagentSpans.clear();
    this.pendingTaskSpans = [];
  }

  private onLlmStart(
    id: string,
    model: string,
    subagentId?: string,
    request?: LlmRequestSnapshot,
  ): void {
    const startTime = Date.now();
    // Snapshot request content to JSON now (synchronously): `request.messages`
    // aliases the live conversation, which mutates before a deferred drain runs.
    const contentAttrs =
      this.cfg.captureContent && request ? llmInputAttributes(request) : undefined;
    this.apply((rt) => {
      const span = rt.tracer.startSpan(
        llmSpanName(model),
        {
          startTime,
          kind: rt.api.SpanKind.CLIENT,
          attributes: {
            ...llmRequestAttributes({ requestModel: model, providerId: this.opts.providerId }),
            ...(request?.ratel ? ratelResolutionAttributes(request.ratel, this.cfg.captureContent) : {}),
            // Control arm: emit feature_flag directly when no ratel snapshot present.
            ...(request?.featureFlag && !request?.ratel ? { "feature_flag": request.featureFlag } : {}),
            ...contentAttrs,
          },
        },
        this.childParentContext(rt, subagentId),
      );
      this.llmSpans.set(id, span);
    });
  }

  private onAssistantMessage(id: string, message: AssistantMessage): void {
    const endTime = Date.now();
    const finishReasons = message.stopReason ? [message.stopReason] : undefined;
    const contentAttrs = this.cfg.captureContent
      ? llmOutputAttributes(message, message.stopReason)
      : undefined;
    this.apply(() => {
      const span = this.llmSpans.get(id);
      if (!span) return;
      this.llmSpans.delete(id);
      if (message.usage) {
        const cost = calcCost(message.model, message.usage, this.opts.pricing, this.opts.providerId);
        span.setAttributes(llmResponseAttributes({ responseModel: message.model, cost, finishReasons }));
      } else {
        span.setAttribute("gen_ai.response.model", message.model);
        if (finishReasons) span.setAttribute("gen_ai.response.finish_reasons", finishReasons);
      }
      if (contentAttrs) span.setAttributes(contentAttrs);
      span.end(endTime);
    });
  }

  private onToolStart(id: string, name: string, subagentId?: string, args?: unknown): void {
    const startTime = Date.now();
    const contentAttrs = this.cfg.captureContent ? toolInputAttributes(args) : undefined;
    this.apply((rt) => {
      const span = rt.tracer.startSpan(
        name,
        {
          startTime,
          kind: rt.api.SpanKind.INTERNAL,
          attributes: {
            ...toolStartAttributes({ name, callId: id }),
            ...(isRatelGatewayTool(name) ? ratelGatewayToolAttributes() : {}),
            ...contentAttrs,
          },
        },
        this.childParentContext(rt, subagentId),
      );
      this.toolSpans.set(id, span);
      // A top-level `task` tool span is the parent for the subagent_start that
      // follows it. Child task tools (carrying a subagentId) don't qualify.
      if (name === TASK_TOOL_NAME && !subagentId) this.pendingTaskSpans.push(id);
    });
  }

  private onToolEnd(id: string, output: string, isError: boolean): void {
    const endTime = Date.now();
    this.apply((rt) => {
      const span = this.toolSpans.get(id);
      if (!span) return;
      this.toolSpans.delete(id);
      // Drop an unclaimed task span (e.g. it errored before subagent_start) so
      // a later subagent can't mis-parent onto it.
      const pending = this.pendingTaskSpans.indexOf(id);
      if (pending !== -1) this.pendingTaskSpans.splice(pending, 1);
      span.setAttributes(toolEndAttributes({ ok: !isError, output }));
      if (this.cfg.captureContent) span.setAttributes(toolOutputAttributes(output));
      if (isError) {
        span.setStatus({ code: rt.api.SpanStatusCode.ERROR });
      }
      span.end(endTime);
    });
  }

  private onSubagentStart(
    subagentId: string,
    agent: string,
    isolation?: string,
    model?: string,
    prompt?: string,
  ): void {
    const startTime = Date.now();
    const contentAttrs =
      this.cfg.captureContent && prompt !== undefined
        ? subagentInputAttributes(prompt)
        : undefined;
    this.apply((rt) => {
      const taskId = this.pendingTaskSpans.shift();
      const taskSpan = taskId ? this.toolSpans.get(taskId) : undefined;
      const parent = taskSpan
        ? rt.api.trace.setSpan(rt.api.ROOT_CONTEXT, taskSpan)
        : this.parentContext(rt);
      const span = rt.tracer.startSpan(
        subagentSpanName(agent),
        {
          startTime,
          kind: rt.api.SpanKind.INTERNAL,
          attributes: { ...subagentStartAttributes({ agent, isolation, model }), ...contentAttrs },
        },
        parent,
      );
      this.subagentSpans.set(subagentId, span);
    });
  }

  private onSubagentEnd(subagentId: string, turns: number, summary?: string): void {
    const endTime = Date.now();
    const contentAttrs =
      this.cfg.captureContent && summary !== undefined
        ? subagentOutputAttributes(summary)
        : undefined;
    this.apply(() => {
      const span = this.subagentSpans.get(subagentId);
      if (!span) return;
      this.subagentSpans.delete(subagentId);
      span.setAttributes(subagentEndAttributes({ turns }));
      if (contentAttrs) span.setAttributes(contentAttrs);
      span.end(endTime);
    });
  }

  async flush(): Promise<void> {
    await this.initPromise;
    if (this.runtime) await this.runtime.forceFlush();
  }
}
