# @neutron/codegen-core

Tier 1 free **Code-Gen Core**. The unified neutron-side replacement
for the host app's `/trident` / `/forge` / `/argus` stack. Type `/code <task>`
in chat (or tap the 🛠 launcher tile) and an in-process Sonnet 4.6
Forge-shape sub-agent authors a branch + opens a draft PR, an
Argus-shape sub-agent reviews HEAD, and on `APPROVE` the orchestrator
auto-merges via the host `gh` CLI — no user confirmation step.

Per docs/plans/code-gen-core-tier1-brief.md +
docs/plans/2026-05-22-002-feat-code-gen-core-s2-autonomous-plan.md.

## Surfaces

- **`/code <task>`** — autonomous Forge → Argus → auto-merge loop.
  The user receives ONE notification when the run lands OR a genuine
  blocker surfaces. Auto-merge is ON by default; there is no per-
  project gate and no `/code automerge` sub-command.
- **`/code stop`** (alias `/code cancel`) — emergency stop the
  most-recent in-flight task in this project. `/code cancel <id>`
  cancels a specific task.
- **4 MCP tools** (`codegen_dispatch` / `codegen_status` /
  `codegen_fetch` / `codegen_cancel` in `src/tools.ts`). These are
  intra-instance — `Tasks Core` can call `codegen_dispatch` to spawn a
  build from a task row.
- **P5.3 launcher tile** + `app_tab` UI component declaration at
  `/projects/<project_id>/code-gen` (browser-based diff viewer is a
  P5.x sprint).
- **Per-project git worktree** at `<OWNER_HOME>/Projects/<id>/code/`
  (resolved by `src/worktree-resolver.ts`).
- **Per-project SQLite sidecar** at
  `<OWNER_HOME>/Projects/<id>/code-gen/code-gen.db` (resolved by
  `src/sidecar/store.ts`).

## Substrate — opaque `CodegenLlmCall` closure

The Core programs against a narrow `CodegenLlmCall` interface defined
in `src/substrate-runtime.ts`. There is ZERO `@anthropic-ai/sdk`
import inside `cores/free/code-gen/`. The gateway-side
`gateway/cores/code-gen-factory.ts` resolves the per-instance credential
(Anthropic Max OAuth → BYO `NEUTRON_ANTHROPIC_API_KEY` env →
no-credential sentinel) and constructs the closure that performs the
actual `client.messages.create(...)` call. Mirrors the Research Core's
`ResearchLlmCall` pattern.

## Auto-merge default ON

When Argus emits `APPROVE`, `RuntimeCodegenRunner` immediately invokes
`gh pr merge --squash` on the open PR. The S1 three-call-site
auto-merge gate (`automerge_enabled` settings column + `/code merge`
chat command + `codegen_merge` MCP tool) was REMOVED in S2 (see
`migrations/0002_drop_automerge_column.sql`). If `gh pr merge` fails
(branch protections, merge conflict, etc.), the runner records a
`merge_failed` row in the sidecar and surfaces the blocker as a single
chat notification — the user gets ONE message either way.

## Sub-agent dispatch

Substrate-agnostic via `runtime/subagent/spawn.ts` (Code-Gen is the
FIRST production caller). The Forge-shape + Argus-shape system
prompts are re-implemented IN-TREE at `src/prompts/forge-system.ts` +
`argus-system.ts` — ZERO imports from external sources / `~/.claude/skills/`.

## SDK capabilities declared

- `read:codegen_core.tasks`
- `write:codegen_core.tasks`
- `agent:dispatch_subagent` (Code-Gen is the FIRST production caller)
- `host:gh` (gateway-host `gh` CLI invocation)
- `network:github` (composed on top of `network:external`)

## Production-composer reachability guard

`gateway/__tests__/code-gen-core-production-composer.test.ts` boots
`composeProductionGraph` against in-memory SQLite + dev-bypass auth +
stubbed sub-agent dispatch + stubbed host runners + a stubbed
`CodegenLlmCall` closure, installs the Core, and exercises the entire
S2 chat surface end-to-end through the production composer chain —
closing the anti-pattern Argus has flagged in 8 consecutive sprints.

## What this Core is NOT

- A full-fledged IDE surface (Tier 2 Code-Pro Core).
- Codex CLI integration (out-of-scope for Tier 1; lands when the
  substrate composer supports it).
- Telegram-side completion-delivery webhooks + inline-keyboard buttons
  (gateway-side plain-text completion message is portable across
  Telegram + P5 chat + Expo mobile).
- Polling-loop coordinators based on CC-skill re-entry primitives
  (the in-process orchestrator awaits sub-agent completions directly
  via `runtime/subagent/control.ts:waitForCompletion`).
