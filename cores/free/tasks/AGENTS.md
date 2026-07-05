# AGENTS.md — cores/free/tasks

This directory is the Tier 1 free Tasks Core (`@neutron/tasks-core`).

## Surface (v0.2.0, S1 — 2026-05-20)

- **Six MCP tools**: `tasks_create` / `tasks_list` / `tasks_update` /
  `tasks_complete` / `tasks_delete` / `tasks_pick_next`. The first
  five are gated by `write:/read:tasks_core.db` per the manifest; the
  6th gates on `read:tasks_core.db` (it reads `pickNextCandidates(...)`
  and does not mutate any row).
- **Four chat commands**: `/task <body>`, `/task done <id_or_match>`,
  `/task list [project_id?]`, `/task focus [project_id?]`. Parser +
  dispatcher in `src/chat-commands.ts`; consumed by the gateway via
  `wrapWithTasksChatRouter(...)` in `gateway/cores/tasks-chat-router.ts`.
- **Two UI components**: `launcher_icon` (P5.3 tile with
  `primary_action='open_app_tab'` + 3-item long-press menu) +
  `app_tab` (declarative metadata pointing at the existing P5.4
  tasks tab path; the Core does NOT mount HTTP routes for it).
- **LLM pick-next service**: `buildPickNextService({store, llm})`
  returns the focus-score top candidate + owner-voice rationale.
  Tests inject `buildStubPickNextLlmClient`; production composer
  wires Sonnet 4.6 with Haiku 4.5 fallback via the claude-runner-mcp
  seam (or the stub until the seam plumbs through composer boot).

## Substrate binding

The Core's tool surface is adapter-bound to the canonical
`@neutron/tasks` substrate via `buildSubstrateTaskStoreBackend` (see
`src/backend.ts`). The Core does NOT own its own task data — every
tool write goes through `tasks/store.ts:TaskStore`. The capability
strings `read:tasks_core.db` / `write:tasks_core.db` are kept for the
runtime's namespace gate; the sidecar is unused at runtime.

## Rules

- DO NOT refactor the `tasks/` substrate workspace package — that's
  the canonical store; the Core is an adapter.
- DO NOT reach into other Cores' namespaces.
- DO NOT add SQLite migrations or open a SQLite handle directly. The
  brief locks ZERO new storage; every read + write flows through the
  canonical `TaskStore` interface.
- DO NOT add HTTP routes for the tasks tab. P5.4 owns the contract
  (`gateway/http/app-tasks-surface.ts`); the manifest's `app_tab`
  surface is purely declarative metadata.
- DO NOT import from external sources or anywhere outside the public Open
  repo (Apache 2.0 boundary).

## Chat-command wiring

`/task` dispatch happens through a thin wrap in the gateway boot
(`gateway/cores/tasks-chat-router.ts`) that intercepts inbound chat
events whose body starts with `/task`. The Core itself is
channel-agnostic — the parser + dispatcher don't know about Telegram
vs app-ws. A future Telegram bridge consumes the same parser without
modification.

## Cross-refs

- `docs/plans/tasks-core-tier1-brief.md` — S1 sprint brief (current work)
- `docs/SYSTEM-OVERVIEW.md § 7.3` — Tier 1 status row
- `docs/SYSTEM-OVERVIEW.md § 8.7.1` — Tasks Core wrap narrative
- `SPEC.md § Phases→Steps` — Tier 1 Cores buildout (TODO(K10): root SPEC.md not yet in this repo; K10 recreates it)
- `cores/sdk/SDK-CONTRACT.md` — author-facing API
- `cores/runtime/` — install / capability gating / audit log
- `tasks/AGENTS.md` — the canonical P6 substrate this Core adapts
