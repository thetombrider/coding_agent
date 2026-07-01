# Ratel Integration Plan — Orin / coding_agent

> Written against **@ratel-ai/sdk v0.2.0** (installed in `node_modules/`) and the current docs fetched via Context7 on 2026-06-30.

---

## Table of Contents

1. [Summary](#summary)
2. [Docs Reference](#docs-reference)
3. [Topology + Tool-Management Map](#topology--tool-management-map)
4. [Integration Plan — What's In, What Needs Work](#integration-plan--whats-in-what-needs-work)
5. [A/B Test Plan](#ab-test-plan)
6. [Metrics & Dashboards](#metrics--dashboards)
7. [Roadmap Pointers](#roadmap-pointers)
8. [Open Questions](#open-questions)
9. [Verification Checklist](#verification-checklist)

---

## Summary

| | |
|---|---|
| **Stack** | TypeScript, Vercel AI SDK (`ai`, `@ai-sdk/anthropic`), Node.js, MCP via `@modelcontextprotocol/sdk` |
| **Tool management** | Dynamic catalog + unified dispatcher — `OrinRatelBundle` (Direct SDK, hybrid MCP) |
| **Integration mode** | **Direct SDK, replace mode** — `resolveToolsForTurn(query)` swaps the `tools:` block every LLM call; MCP upstreams ingested via `registerMcpServer` into the same `ToolCatalog` (Mode 3 hybrid per `integration-patterns.md`) |
| **SDK version** | `@ratel-ai/sdk@0.2.0` ✅ — `searchCapabilitiesTool`, `invokeToolTool`, `getSkillContentTool`, `SkillCatalog`, `registerMcpServer` all present |
| **Status** | Integration is **live and in production** — replace mode, gateway tools, skill catalog, MCP ingestion, and telemetry are all wired. Core gaps: (1) no control-arm A/B split, (2) `ratel_unavailable_tool_call` guardrail score not emitted, (3) Context7 docs reference old `searchToolsTool` — the codebase correctly uses `searchCapabilitiesTool` (v0.2.0 rename, no action needed). |
| **Pilot scope** | Already running on 100% of sessions. Recommend adding a 10% control arm to prove the win. |
| **A/B strategy** | Add env-var / config-flag split: `ratel.enabled = false` for 10% of sessions, tag traces `feature_flag = tool_pool=full` for the control arm. |

---

## Docs Reference

- **Source**: `node_modules/@ratel-ai/sdk/README.md` (pinned version, most accurate for this install) + Context7 `/ratel-ai/ratel` corpus.
- **Version shipped**: `0.2.0`.
- **API delta noted**: Context7 docs show `searchToolsTool` (older name); the installed SDK exposes `searchCapabilitiesTool` — the codebase correctly uses the current name. The Context7 index lags slightly on this rename; no action needed in the code.

---

## Topology + Tool-Management Map

### Integration site: `src/agent/loop.ts:269`

```
const ratelResolution = options.ratel?.resolveToolsForTurn(userQuery);
const providerTools = ratelResolution?.tools ?? options.tools;
```

`ratel` is an `OrinRatelBundle` instance, passed from `bootstrapOrinTooling` → `runLoop`. Every LLM call gets a BM25-filtered tool list (replace mode). The bundle is optional — when `ratel.enabled` is `false`, the full flat list is used.

### Tool registration topology

| Layer | Location | Registered into |
|---|---|---|
| Native core tools | `src/ratel/tools.ts:coreToolsForRatel()` | `ToolCatalog` via `registerOrinTool` |
| MCP upstreams | `src/ratel/mcp.ts:loadMcpIntoRatelCatalog()` | `ToolCatalog` via `registerMcpServer` (native MCP transport) |
| Gateway tools exposed to LLM | `src/ratel/catalog.ts:wrapGateway()` | Wrapped as `AnyTool` and injected by `resolveToolsForTurn` |
| Skills | `src/ratel/skills.ts:registerDiscoveredSkills()` | `SkillCatalog` |

### Catalog size estimate

Core tools (minus `skill_list` / `skill_use` replaced by gateway) = ~20–25 tools. MCP servers vary per user config. At a typical install with 5–10 MCP servers (15–50 tools each), the catalog grows to 100–500 tools — well above the 15-tool threshold where Ratel's BM25 lift is material.

### Config knobs (`src/ratel/config.ts`)

```ts
DEFAULTS = {
  enabled: true,
  topKTools: 5,
  topKSkills: 3,
  pinnedTools: ["read", "write", "edit", "bash", "grep", "find", "ls",
                "search_capabilities", "invoke_tool"],
}
```

Loaded from `~/.orin/config.json` → `ratel.*`. These are sane defaults. `pinnedTools` is the protected core — gateway tools and the six most-used filesystem tools are never trimmed. The protected core needs a review if tool names change (see gap 1 below).

### Prompt caching posture

The codebase uses Anthropic via `@ai-sdk/anthropic`. The `tools:` block is rebuilt every turn by `resolveToolsForTurn`, which means **replace mode rewrites the tool block on every turn**. On Anthropic models with prompt caching, the `tools` block sits early in the cached prefix and a per-turn change can invalidate the cache. This is the replace-mode cache trap (`integration-patterns.md` §3). Whether this is a regression depends on:

- Whether the caller enables Anthropic prompt caching (Beta header `anthropic-beta: prompt-caching-2024-07-31`).
- Whether the provider SDK (`@ai-sdk/anthropic`) activates caching by default.

**Action needed**: check `src/provider/providers/anthropic.ts` to determine if caching is on; if it is, consider recall mode for long multi-turn sessions.

---

## Integration Plan — What's In, What Needs Work

### ✅ Already correct

| Area | File | Status |
|---|---|---|
| `ToolCatalog` + native tool registration | `src/ratel/catalog.ts:116–162` | Correct — one catalog, `registerOrinTool` wires both BM25 and dispatch |
| MCP upstream ingestion via `registerMcpServer` | `src/ratel/mcp.ts:57–147` | Correct — Mode 3 hybrid, single catalog |
| Gateway tools wired to LLM (`searchCapabilitiesTool`, `invokeToolTool`, `getSkillContentTool`) | `src/ratel/catalog.ts:231–281` | Correct — v0.2.0 API |
| `SkillCatalog` + `getSkillContentTool` | `src/ratel/catalog.ts:79, 246` | Correct — passes skill catalog to `searchCapabilitiesTool` only when non-empty |
| BM25 pre-filter called per turn | `src/agent/loop.ts:269` | Correct — `latestUserText` feeds the query |
| Telemetry: `ratel.prefilter` metric on `llm_start` | `src/ratel/telemetry.ts:153–165` | Correct — emits `ratel.*` attributes including `feature_flag`, `catalog_size`, `injected_count`, `hit_count`, `top_hit_score` |
| Telemetry: gateway trace events drained after `tool_end` | `src/ratel/telemetry.ts:119–151` | Correct — drains `gateway_search`, `gateway_invoke`, `skill_search`, `skill_invoke` |
| `featureFlag = "tool_pool=ratel"` on every prefilter span | `src/ratel/catalog.ts:269`, `src/agent/events.ts:38` | Correct — hardcoded on the Ratel arm. **Missing: no control arm emitting `tool_pool=full`**. |
| `gatewayOrigin = "direct"` on prefilter (LLM-driven replacement) | `src/ratel/catalog.ts:268` | Correct — `"direct"` means the pre-filter chose the tools, not the agent. Agent-invoked gateway calls get `"agent"` origin via `normalizeRatelTraceEvent`. |
| `UpstreamServerInfo` passed to `searchCapabilitiesTool` | `src/ratel/catalog.ts:104–109` | Correct — populates the upstream server info panel in the search results |
| Skill refresh on skill write | `src/ratel/catalog.ts:193–197` | Correct — `refreshSkills()` rebuilds both `SkillCatalog` and gateway tools |
| Gateway `invoke_tool` honors `needsApproval` of underlying tool | `src/ratel/catalog.ts:303–313` | Correct — approval gate is preserved through the gateway |

### ⚠️ Gaps to address

#### Gap 1 — No control arm: the A/B split is missing

**Problem**: `featureFlag` is always `"tool_pool=ratel"`. There is no control arm emitting `"tool_pool=full"`. Without a split, the Token Cost & Savings dashboard cannot show a before/after comparison — all sessions are in the treatment arm.

**Fix** (see [A/B Test Plan](#ab-test-plan) below): add a 10% config-flag split that bypasses `resolveToolsForTurn` and tags traces `feature_flag = tool_pool=full`.

**File**: `src/agent/loop.ts:269–271` and `src/ratel/catalog.ts:269`.

#### Gap 2 — `ratel_unavailable_tool_call` score not emitted

**Problem**: When `resolveToolsForTurn` trims a tool from the injected set and the model calls it anyway (via `invoke_tool` or a hallucinated direct call), this is not separately scored. The `registry.get(call.name)` path in `src/agent/loop.ts:113` returns an error for unknown tools, but no `ratel_unavailable_tool_call` metric is emitted.

**Fix**: in `executeSingleTool` (`src/agent/loop.ts:105`), when `registry.get(call.name)` returns `undefined` AND Ratel is active AND the tool _exists_ in `ratel.orinTools`, emit a `ratel_unavailable_tool_call` metric. This distinguishes "Ratel trimmed it" from "genuine hallucination."

```ts
// Pseudocode — add to executeSingleTool when tool === undefined
if (options.ratel?.getOrinTool(call.name)) {
  emitAll(sinks, { type: "ratel", name: "ratel.unavailable_tool_call",
                    attributes: { "ratel.tool_id": call.name, "feature_flag": "tool_pool=ratel" } });
}
```

**File**: `src/agent/loop.ts:113–119` and `src/telemetry/install.ts` (thread sinks through `RunLoopOptions`).

#### Gap 3 — Prompt caching posture not confirmed

**Risk**: if `@ai-sdk/anthropic` sends the Anthropic `prompt-caching` beta header, then replace mode rewrites the cached `tools:` block every turn, busting the cache. This would show up as `cache_read_tokens` near zero even in multi-turn sessions.

**Action**: read `src/provider/providers/anthropic.ts` and confirm whether caching is active. If yes, evaluate switching long-session multi-turn loops to recall mode (stable eager tool list + BM25 hits appended as synthetic `search_capabilities` result in the transcript suffix).

#### Gap 4 — `ratelJsonlTraceSink` is defined but not wired

`src/ratel/trace.ts` defines both `ratelTraceSink` (memory, used) and `ratelJsonlTraceSink` (JSONL file, unused). The JSONL sink is useful for local debugging and offline analysis. Consider wiring it behind a config flag (`ratel.traceJsonl: true`) for power users.

**File**: `src/ratel/catalog.ts:122` — only passes `ratelTraceSink`; `ratelJsonlTraceSink` is never called.

---

## A/B Test Plan

### Strategy: env-var / config-flag split (10% control)

The codebase has no LaunchDarkly or feature-flag SaaS. The cleanest minimal split uses the existing `ratel.enabled` config key.

**Implementation**:

1. In `src/ratel/config.ts`, add a `controlFraction: number` field (default `0`). When non-zero, a deterministic hash of the `sessionId` determines which arm a session is in.
2. In `src/ratel/session.ts:bootstrapOrinTooling`, after resolving settings:
   ```ts
   const inControl = controlFraction > 0 && sessionHash(sessionId) < controlFraction;
   if (inControl) {
     // Control arm: full tool list, no pre-filter
     return { tools: [...getCoreTools(), ...mcp.tools], ratel: undefined, ... };
   }
   ```
3. In the control arm path, emit `feature_flag = "tool_pool=full"` on `llm_start` by adding it to a minimal telemetry snapshot (or via a hook-level attribute).

**Trace tags**:

| Arm | `feature_flag` attribute value | How set |
|---|---|---|
| Treatment (Ratel) | `tool_pool=ratel` | `RatelResolutionSnapshot.featureFlag` — already hardcoded |
| Control (full list) | `tool_pool=full` | New: emitted as a bare attribute on `llm_start` when `inControl` |

**Ramp plan**:
- Week 1: 10% control, 90% Ratel. Watch `ratel_unavailable_tool_call` → should be ~0.
- Week 2: if token delta is measurable, document it and widen Ratel to 100%. Disable control arm.

**No shadow mode needed** — this agent is not customer-facing in a way that requires zero-risk rollout. A live 10% split is the right call.

---

## Metrics & Dashboards

The telemetry backend is **OTLP/HTTP** (config: `telemetry.otel.endpoint`), compatible with Langfuse Cloud (OTLP ingestion). Metrics are emitted as OTel spans; `ratel.*` attributes land as observation metadata.

| Dashboard | What it needs | Current status | After A/B rollout |
|---|---|---|---|
| **Token Cost & Savings** (split by `feature_flag`) | `gen_ai.usage.input_tokens` on `llm_start` spans, `feature_flag` tag | Only `tool_pool=ratel` arm exists — no baseline. **Blocked on Gap 1.** | ✅ Both arms visible, delta computable |
| **Retrieval Quality** | `ratel.hit_count`, `ratel.top_hit_score`, `ratel.top_k` on `ratel.prefilter` spans | ✅ All emitted via `ratelResolutionAttributes` | ✅ No change needed |
| **Gateway Origin Split** | `ratel.gateway_origin` (`direct` vs `agent`) on `ratel.*` spans | ✅ Prefilter emits `direct`; gateway tool calls emit `agent` | ✅ No change needed |
| **Stranded-tool guardrail** (`ratel_unavailable_tool_call`) | Custom score per tool call to a trimmed tool | ❌ Not emitted. **Gap 2.** | ✅ After Gap 2 fix: trend to ~0 confirms protected core is correct |
| **Prompt-cache regression** | `gen_ai.usage.cache_read_tokens` per arm | Present in `llmResponseAttributes` (if non-zero) | ✅ After A/B: compare cache hit rates between arms |
| **Skill activity** | `ratel.skill_search`, `ratel.get_skill_content` spans | ✅ Emitted via `normalizeRatelTraceEvent` | ✅ No change needed |

**Score wiring**: there is currently no ground-truth tool-id labelling, so `tool_selection_accuracy` and `top_k_recall_at_5` cannot be computed. Revisit when an eval dataset with gold tool ids per task exists.

---

## Roadmap Pointers

- **Suggestions / decomposition**: not relevant to current integration (replace mode is already shipped and working). Revisit if the team wants the model to propose new skills from repeated patterns.
- **Recall mode** (stable eager tool list): relevant now if prompt caching is confirmed active (Gap 3). The implementation swap is in `resolveToolsForTurn` — replace the `add(...)` + `topK` loop with a stable set of pinned + eager tools and append BM25 hits as a `search_capabilities` synthetic tool result. See `integration-patterns.md` §recall-mode.
- **JSONL trace sink**: minor quality-of-life for debugging (Gap 4). Low priority.

---

## Open Questions

1. **Is Anthropic prompt caching active in `src/provider/providers/anthropic.ts`?** If yes, Gap 3 is a token-cost regression risk and recall mode should be evaluated.
2. **What is the typical catalog size at user installs?** MCP server count varies widely. If most users have <15 MCP tools total, the Ratel win is marginal and the A/B split will show a small delta. Data from the Retrieval Quality dashboard will answer this.
3. **Should the control arm be session-level or turn-level?** Session-level (hash on `sessionId`) avoids within-session switching artifacts. Turn-level would give more data faster but risks confounding effects.
4. **Is there a ground-truth tool labelling dataset** (even a small one, 50–100 examples) that could drive `tool_selection_accuracy`? If so, the score-wiring is a one-afternoon addition.

---

## Verification Checklist

After the A/B split (Gap 1) and stranded-tool guardrail (Gap 2) are landed:

- [ ] **Pilot trace sessions use Ratel**: `feature_flag = tool_pool=ratel` appears on `llm_start` spans in the OTLP backend. Confirmed by querying traces filtered on `feature_flag`.
- [ ] **`feature_flag` tag is split correctly**: both `tool_pool=ratel` and `tool_pool=full` appear in traces, at roughly the configured ratio (e.g. 90/10).
- [ ] **`ratel.search_capabilities` observations appear**: gateway search events show `ratel.hit_count > 0` for queries that should match tools (e.g. "read file", "run bash command").
- [ ] **`ratel_unavailable_tool_call` trends to ~0**: after fixing Gap 2, this metric should rarely fire. Sustained non-zero values mean the protected core (`pinnedTools`) is incomplete.
- [ ] **Token Cost & Savings dashboard shows arm separation**: treatment arm (`tool_pool=ratel`) has measurably lower `gen_ai.usage.input_tokens` per turn than control arm (`tool_pool=full`). If not measurable with the catalog size, the delta is real but small — document it.
- [ ] **Prompt-cache regression check**: if caching is active, `gen_ai.usage.cache_read_tokens` in the Ratel arm is not materially lower than the control arm. If it is, switch to recall mode.
