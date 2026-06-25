# Skills Research: AgentSkills Standard, OpenCode, and Hermes Agent

Research for issues #240 (Hermes Agent) and #241 (Skills support).

---

## 1. AgentSkills Standard (agentskills.io)

Originally developed by Anthropic, released as open standard (Apache 2.0 / CC-BY-4.0). Adopted by Claude Code, OpenCode, VS Code Copilot, OpenAI Codex, GitHub Copilot, Cursor, Junie, and 10+ other tools.

### SKILL.md format

```
skill-name/
├── SKILL.md          ← required: YAML frontmatter + markdown instructions
├── scripts/          ← optional: executable helpers
├── references/       ← optional: docs, API specs
└── assets/           ← optional: templates, binaries
```

Minimum valid `SKILL.md`:
```markdown
---
name: skill-name
description: One-line description of when to use this skill
version: 1.0.0
---

## Instructions

Step-by-step markdown here.
```

Required frontmatter fields: `name` (1-64 chars, lowercase-hyphens), `description`.
Optional: `version`, `author`, `license`, `platforms`, `prerequisites`, `metadata.*`.

### Progressive disclosure (three-phase loading)

1. **Discovery** — agent loads only `name` + `description` from frontmatter (~3k tokens total for all skills)
2. **Activation** — agent reads full `SKILL.md` when a task matches the description
3. **Execution** — agent follows instructions, optionally runs scripts or loads reference files

This minimizes context overhead: the agent pays attention cost only for relevant skills.

---

## 2. OpenCode skills implementation

OpenCode (the opencode-agent-skills plugin pattern) implements the spec with these patterns:

### Directory search order (project overrides global)
```
.opencode/skills/<name>/SKILL.md       ← project-local (highest priority)
.claude/skills/<name>/SKILL.md         ← cross-agent compat (also local)
~/.config/opencode/skills/<name>/SKILL.md  ← user-global
~/.claude/skills/<name>/SKILL.md       ← user-global compat
~/.agents/skills/<name>/SKILL.md       ← user-global compat
```

### Four tools exposed to the agent
| Tool | Purpose |
|------|---------|
| `get_available_skills` | Lists all discovered skills (name + description only) |
| `use_skill` | Loads a specific skill's full SKILL.md into context |
| `read_skill_file` | Reads a supporting file from a skill directory |
| `run_skill_script` | Executes a script bundled with a skill |

### Key implementation patterns
- **Lazy loading via `ReadyStateMachine`**: skill index built in background; tools ready immediately
- **Auto-injection on session start**: skills list wrapped in `<available-skills>` tags injected into every prompt
- **Compaction resilience**: listens for `session.compacted` events and re-injects the skill index so it survives context compression
- **Semantic matching**: monitors messages for semantic similarity to available skill names
- **Security**: skill file paths pre-indexed at parse time; no path traversal possible

---

## 3. Hermes Agent (NousResearch) — self-learning skills

Hermes Agent (201k GitHub stars, MIT) implements skills + autonomous self-improvement.

### Skills system

Storage: `~/.hermes/skills/` with subdirectory categories. Format follows agentskills.io.

Extended YAML frontmatter:
```yaml
name: skill-identifier
description: Brief description
version: 1.0.0
platforms: [macos, linux]
metadata:
  hermes:
    tags: [category, tags]
    category: devops
    requires_toolsets: [terminal]
    fallback_for_toolsets: [web]
```

Scale: 166 skills (87 bundled + 79 optional) across 26 categories.

### Autonomous skill creation (the self-learning loop)

After **complex tasks (5+ tool calls)**, Hermes automatically creates skills:

```
Task completes → Evaluate success → Extract reusable pattern → skill_manage(create) → SKILL.md written
```

The `skill_manage` tool takes actions:
- `create` — new skill from scratch
- `patch` — targeted string-replacement fix (preferred for efficiency)
- `edit` — full SKILL.md rewrite
- `delete` — remove skill
- `write_file` / `remove_file` — manage supporting files

Skills also **self-patch during use** when they prove incorrect or incomplete.

### Write approval system

```yaml
# config.yaml
skills:
  write_approval: true  # stage writes for human review instead of committing immediately
```

When enabled: writes go to `~/.hermes/pending/skills/`. User reviews with:
```
/skills pending        # list staged
/skills diff <id>      # unified diff
/skills approve <id>   # apply
/skills reject <id>    # discard
```

### Autonomous Curator (v0.12.0+)

Background daemon running on a 7-day cycle:
- Grades each skill by usage frequency and recency
- Consolidates overlapping skills
- Archives stale skills (keeps backup tar.gz)
- CLI: `hermes curator status|run|pause|resume|pin|unpin|archive|restore|prune`

### Memory vs skills

| | Memory (MEMORY.md) | Skills |
|---|---|---|
| **Purpose** | Durable facts about the user/project | Reusable procedures |
| **Size** | Small (always in context) | Larger (loaded on demand) |
| **Trigger** | Always injected | Loaded when task-relevant |

### hermes-agent-self-evolution (ICLR 2026 Oral, MIT)

Companion repo applying **DSPy + GEPA** (evolutionary prompt optimization) to improve skills:

```
Read existing skills → Generate eval data → GEPA optimizer → Candidate variants
→ Evaluate vs execution traces → Constraint gates → Best variant → PR for review
```

Guardrails:
- All variants must pass full pytest suite
- Skills ≤15KB
- No mid-conversation modifications (caching compatibility)
- Semantic stability check (preserves original purpose)
- Human review via PR before integration
- ~$2-10 per optimization run via API (no GPU needed)

Performance claim: agents with 20+ self-created skills complete similar tasks 40% faster.

---

## 4. What to implement in Orin (issue #241)

Based on this research, the right approach for Orin is:

### Phase A — Core skills (implemented in this branch)

Three tools added to the registry:

| Tool | Approval | Description |
|------|----------|-------------|
| `skill_list` | no | Lists available skills (name + optional version + description — progressive disclosure level 0) |
| `skill_use` | no | Loads a skill's full instructions + optional supporting file |
| `skill_write` | **yes** | Creates, updates, or deletes a skill (self-learning mechanism) |

Directory search: project `.orin/skills/` and `.claude/skills/` (cwd-to-root traversal, .orin tier before .claude tier) → `~/.orin/skills/` (global fallback).

Auto-injection: `installSkillInject` hook injects `<available-skills>` into every prompt when skills exist — agent discovers them without calling `skill_list`.

`skill_write` is excluded from child/subagent tool presets (only the primary agent writes skills).

### Phase B — Future work

- **Scope: project skills** — `skill_write({ scope: "project" })` is already supported; add `.orin/skills/` to `.gitignore` or commit it by convention
- **Write approval config** — `config.skills.write_approval: true` to stage writes for human review (mirrors Hermes)
- **Supporting files** — `skill_use({ file: "references/api.md" })` already works; `skill_write` could add `write_file` action
- **Curator** — periodic cleanup of unused/stale skills (long-term)
- **Evolution** — integrate GEPA-style prompt optimization on skill content (stretch)
- **AgentSkills hub** — install skills from agentskills.io (stretch)
