# @neutron/tasks-core

Tier 1 free Tasks Core for Neutron. v0.2.0 (S1 — 2026-05-20).

## Surfaces

**Six MCP tools** (each capability-gated via Sprint 31
`CapabilityGuard.wrapToolHandler`):

- `tasks_create` — create a new task (capability `write:tasks_core.db`)
- `tasks_list` — list tasks, newest-first by default, opt-in
  `order='focus_score'` (capability `read:tasks_core.db`)
- `tasks_update` — patch one or more fields on an existing task (write)
- `tasks_complete` — mark a task done, stamping `completed_at` (write)
- `tasks_delete` — delete a task by id (write)
- `tasks_pick_next` — LLM-driven pick-next: returns the one task to
  do right now + a owner-voice rationale + up to N runner-up alternatives
  (read; no mutation)

**Four chat commands** parsed by `src/chat-commands.ts`:

- `/task <body>` — capture a task in the current project
- `/task done <id_or_match>` — mark a task complete (case-insensitive
  fuzzy substring fallback)
- `/task list [project_id?]` — focus-score-ordered preview
- `/task focus [project_id?]` — fire `tasks_pick_next` and return the
  candidate + rationale + alternatives

**Two UI components** in the manifest:

- `launcher_icon` — P5.3 tile with `primary_action='open_app_tab'`,
  `app_tab_path='/projects/<project_id>/tasks'`, and a 3-item
  long-press menu (capture / browse / pick-next).
- `app_tab` — declarative metadata pointing at the existing P5.4
  `/projects/<id>/tasks` HTTP surface. No new HTTP routes mounted by
  the Core — P5.4 owns the read/write contract.

Bundled into the public OSS repo at `cores/free/tasks/` per the locked
2-tier Cores model (`docs/research/neutron-cores-marketplace-split-2026-05-17.md`).

## Install

The runtime composer installs this Core automatically when the
bundled-Core registry boots from a root that includes `cores/free/*`.
The lifecycle module:

1. Validates the manifest (Sprint 24 `parseManifest`).
2. Allocates a sidecar SQLite layout at `<dataDir>/cores/tasks_core.db`
   (driven by the `read:/write:tasks_core.db` capabilities). The Core
   never opens the sidecar — it's the namespace-accounting indirection
   the capability gate uses.
3. Registers the six MCP tools via `buildTools(deps)`. When `deps`
   carries a `pickNext: PickNextService`, the 6th tool registers too;
   otherwise only the 5 legacy tools are returned.

## Substrate (ZERO new storage)

The Core wraps `tasks/store.ts:TaskStore` (the canonical P6 substrate)
via `buildSubstrateTaskStoreBackend(...)`. ZERO direct SQLite access;
ZERO new migrations. The substrate-backed adapter:

- Stamps `source = '@neutron/tasks-core'` on every Core-driven write
  so an operator can attribute rows in the canonical `tasks` table.
- Filters out `'cancelled'` rows on read (the Core's enum is
  `'open' | 'done'`).
- Threads the same canonical `TaskStore` instance the gateway
  attaches projection + reminder-link subscribers to — Core-driven
  writes fire the STATUS.md projection AND the auto-linked reminder.

`buildInMemoryTaskStore(...)` ships alongside as a reference + test
helper; it is NEVER wired in production.

## Pick-next service

`buildPickNextService({store, llm})` returns a `PickNextService`. The
service:

1. Pulls the focus-score-ranked top-20 open tasks via
   `store.pickNextCandidates({project_id?, limit})`.
2. Hands them to the supplied `PickNextLlmClient.rank(...)` with the
   locked v1 prompt (`PICK_NEXT_PROMPT_TEMPLATE`).
3. Returns `{candidate, rationale, alternatives, audit}` where
   `audit.llm_model` carries the model id for observability.
4. Empty-backlog short-circuit: returns `{candidate: null, ...}`
   WITHOUT calling the LLM.

`buildStubPickNextLlmClient()` is the deterministic stub tests +
the dev composer use; the production composer wires the Sonnet
4.6 with Haiku 4.5 fallback path (claude-runner-mcp seam).

## Chat-command wiring

The gateway boot wraps the channel router with
`wrapWithTasksChatRouter(...)` from
`gateway/cores/tasks-chat-router.ts`. The wrap intercepts inbound chat
events whose body starts with `/task`, parses + dispatches through
this Core's `executeTaskCommand`, and emits the response back via the
session registry. Non-`/task` bodies fall through to the LLM path
unchanged. Telegram-side `/task` parity is a mechanical follow-up
(`channels/adapters/telegram/...` just consults the same
`parseTaskCommand` + `executeTaskCommand` pair).

## Testing

```
bun test cores/free/tasks --max-concurrency=2
```

The Core's own tests use `buildInMemoryTaskStore` so they run without
persistent backend. The production-composer reachability test is at
`gateway/__tests__/tasks-core-chat-pick-next-composer.test.ts` —
boots `composeProductionGraph`, POSTs `/api/app/chat/send` with each
verb, asserts the chat-router short-circuits + the canonical `tasks`
row carries the Core's source tag.

Cross-refs:

- `docs/plans/tasks-core-tier1-brief.md` — S1 sprint brief (this work)
- `docs/SYSTEM-OVERVIEW.md § 8.7.1` — narrative + integration map
- `SPEC.md § Phases→Steps` — Tier 1 Cores buildout order (TODO(K10): root SPEC.md not yet in this repo; K10 recreates it)
- `cores/sdk/SDK-CONTRACT.md` — manifest contract
- `tasks/store.ts` — canonical substrate
