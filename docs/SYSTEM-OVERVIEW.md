# System Overview

High-level map of how Neutron Open boots and where the major runtime
pieces live. Keep this short; deep detail belongs in `AS-BUILT.md` and the
per-module headers.

## Boot path

`gateway/index.ts:boot()` opens the per-instance SQLite DB, applies
migrations, then composes the module graph from a **graph composer**
resolved via the `NEUTRON_GRAPH_COMPOSER_MODULE` env seam
(`loadGraphComposerFromEnv`). Managed deploys point that env at the
private `provisioning/realmode-composer.ts`; Open self-hosts leave it
unset and boot a `/healthz`-only shell. The composer produces a
`CompositionInput` → `composeProductionGraph` (`gateway/composition.ts`)
wires the channel router, MCP/tool registry, HTTP surfaces, and the
bundled Cores.

## Cores

Bundled Cores live under `cores/free/`. Each Core's production runtime is
assembled by a single wiring entrypoint that the composer calls, and its
MCP-tool backend is threaded through `buildCoresBackendFactories`
(`gateway/boot-helpers.ts`) so the chat-command filter and the MCP tools
share one backend instance. Examples:
- Research: `buildProductionResearchCoreWiring` (in-Core).
- Code-Gen: `buildProductionCodegenCoreWiring`
  (`gateway/cores/build-production-codegen-wiring.ts`, gateway-side
  because its Anthropic credential factory is gateway-side).

## Doc search (QMD-equivalent) — `@neutronai/doc-search`

The agent-native corpus search over the owner's project docs, so the live
agent can "research before asking" by searching every project's markdown
mid-conversation. It is the Neutron equivalent of Vajra's QMD.

- **Index (`doc-search/store.ts`).** A `bun:sqlite` FTS5 index over
  heading-scoped markdown chunks. `doc_chunks` holds the content; `doc_fts`
  is an external-content FTS5 mirror over `(title, heading, body)` kept in
  sync by triggers. Ranking is **BM25** with column weights (title ≫ heading
  ≫ body), normalised to a [0,1] relevance and collapsed to the best chunk
  per file, so a query returns ranked DOCUMENTS with the matching section's
  heading + a snippet. Pure-lexical baseline — no external dependency.
  Semantic re-rank is OPTIONAL behind the `embedder` seam (off by default).
- **Corpus (`doc-search/walk.ts`, `indexer.ts`, `projects.ts`).** Indexes
  `.md`/`.markdown` under every `<owner_home>/Projects/<id>/` (README /
  STATUS / CLAUDE / docs / research / notes / archive), skipping hidden dirs
  (`.git`), `node_modules`, oversized files, and symlink escapes. Reindex is
  incremental (mtime-diffed): unchanged files skip, deleted files/projects are
  purged.
- **Runtime + tools (`doc-search/runtime.ts`, `tool.ts`).**
  `DocSearchRuntime` binds the index to `owner_home` and refreshes lazily +
  throttled before each search. `registerDocSearchToolSurface` registers two
  read-only `read:docs` agent tools: **`doc_search`** `{query, project?,
  limit?}` and **`doc_read`** `{project, path}` (path-safe, scoped to
  `Projects/<id>/`).
- **Wiring.** The `tools` module
  (`gateway/composition/build-core-modules.ts`) registers the surface when the
  composer supplies `MiscCompositionInput.doc_search.runtime`. `open/composer.ts`
  builds the index at `<owner_home>/cache/doc-search/index.db`, threads the
  runtime in, and closes it on shutdown (failure-isolated).

## Message search (chat-history FTS) — `@neutron/chat-core` + `@neutronai/message-search`

The chat-history twin of doc-search: full-text search over the user's CHAT
MESSAGES (not docs), so both the user and the live agent can find "where did we
talk about X". The full-text index lives in the chat-core **Store** — the same
seam the sync engine, send-queue, and UI already depend on — so search rides
the existing per-platform durable store without forking the engine.

- **Store contract (`chat-core/store.ts`, `search.ts`).** `Store` gains
  `searchMessages(query, opts)` → ranked, `[`…`]`-highlighted
  `MessageSearchHit[]`, scoped by `topic_id` / `project_id` or global
  (omit both). `sanitizeFtsQuery` turns free text into a safe FTS5 MATCH
  expression (no operator injection; hyphenated terms phrase-quoted), shared
  by both backends.
- **Durable backend — real FTS5 (`app/lib/chat-core/sqlite-store.ts`).** The
  op-sqlite (RN) / bun:sqlite (tests) / wasm-SQLite (web, when it lands) store
  adds a `chat_fts` **external-content FTS5** mirror over the message `body`,
  kept in lock-step with `chat_messages` by AFTER INSERT/DELETE/UPDATE triggers
  (so the store's only write path stays the message table). Ranking is **BM25**
  normalised to a [0,1] relevance, ordered relevance-then-recency, with
  SQLite `snippet()` highlights. A cold-open over a pre-search DB one-shot
  `'rebuild'`s the index from existing rows.
- **Fallback backend — tokenised JS (`InMemoryStore`).** The always-available
  fallback (and the substrate behind today's OPFS web store) implements the
  SAME `MessageSearchHit` contract with an AND-of-terms scan, TF/length
  relevance blended with recency, and identical `[`…`]` highlighting — so the
  query API behaves the same regardless of substrate.
- **Runtime + tool (`message-search/runtime.ts`, `tool.ts`).**
  `StoreMessageSearchRuntime` wraps any chat-core Store (client: topic /
  project / global). `HistorySourceMessageSearchRuntime` is the server shape:
  it hydrates an ephemeral in-memory FTS index from one topic's history (no
  persistent server index). `registerMessageSearchToolSurface` registers the
  read-only `read:project_data` **`message_search`** `{query, limit?, global?}`
  tool — scoped to the CURRENT conversation by default (the call's `topic_id`),
  `global=true` to widen.
- **Wiring.** The `tools` module
  (`gateway/composition/build-core-modules.ts`) registers the surface when the
  composer supplies `MiscCompositionInput.message_search.runtime`.
  `open/composer.ts` supplies a runtime backed by the owner's ButtonStore turn
  history (`gateway/composition/message-search-wiring.ts`), so the live agent
  can recall earlier turns mid-conversation. Server search is per-topic by
  design; cross-topic global search is the client store's job.

## `/code` → foundational Trident (DONE — Trident-port PR-5)

The ~5-PR port folding Vajra's full Trident into Neutron Open as
foundational runtime is **complete**. `/code <task>` now routes through
foundational Trident: the production filter `buildTridentCodeChatCommandFilter`
parses the command and CREATES a `code_trident_runs` row
(`trident/code-command.ts`), and the tick loop drives it build → review → fix
loop → merge → done (or the Ralph plan↔task loop for governed repos). State
in SQLite ⇒ restart-safe + resumable. See "Trident — the foundational
autonomous-build runtime" above for the boot wiring.

The Code-Gen Core (`cores/free/code-gen/`) wrapper is **superseded** for
`/code`: `buildCodegenChatCommandFilter` + `CodegenOrchestrator` no longer
back the `/code` path. The Core's four `codegen_*` MCP tools remain a Tier-2
surface, and the physical deletion of the now-redundant Core orchestration
(+ relocating the shared substrate machinery) is the one documented remaining
cleanup — deferred because the orchestration is still referenced by those MCP
tools, the install lifecycle/manifest, the Managed graph composer, and ~106
self-contained passing tests. See `AS-BUILT.md` PR-5 Decisions Log.

## Foundational Trident — state machine + tick + git-mode + the loop (`trident/`)

The `trident/` module (package `@neutronai/trident`) is the durable runtime
for the autonomous Forge → Argus → merge pipeline, ported from Vajra's
`/trident` skill. It is foundational runtime, not a Core. PR-2 landed the
state-machine skeleton; **PR-3 wired the real agentic loop** (below).

- **Persistence** — `code_trident_runs` (migration 0077): one row per
  pipeline. The SQLite translation of Vajra's per-run JSON state file. The
  in-flight sub-agent's id + status live ON the row (`subagent_run_id` /
  `subagent_status`) so the loop is restart-safe, instead of in the
  disconnected generic `runtime/subagent/` registry. `TridentRunStore`
  (`trident/store.ts`) is the CRUD wrapper, shaped like `ReminderStore`.
- **State machine** — `advanceTridentRun(run, deps)`
  (`trident/state-machine.ts`): the phase graph
  `forge-init → {argus | ralph-plan} → ralph-task → … → argus ⇄ forge-fix
  → done` with terminal `done | failed | stopped`, the Argus round cap
  (`max_rounds`, default 8) and the Ralph plan↔task round cap
  (`max_ralph_rounds`, default 20). The pure `computeTransition` owns the
  control flow; `deps.classify` reads the sub-agent outcome. PR-2 shipped
  `stubAdvanceDeps` (always "running"); PR-3 supersedes it with a real
  spawn+poll+merge `step` (below).
- **The loop** (PR-3) — `buildTridentOrchestrator` (`trident/orchestrator.ts`)
  composes the real loop into a tick `step`: (1) spawn the current phase's
  Forge/Argus substrate session — the single `subagent_run_id === null`-
  guarded spawn site, so a re-entrant tick never double-spawns; (2) poll +
  transition via the pure `advanceTridentRun`; (3) merge on `done`.
  `TridentSessionManager` (`trident/session.ts`) bridges a blocking
  `TridentDispatch` (Forge/Argus turn → terminal text) onto the poll model
  and parses the verdict; `trident/prompts.ts` owns the ported Forge/Argus
  prompts + parsers + the **oversized-diff guard** (`chooseArgusScope`:
  never read a >3000-line diff in one shot); `trident/merge.ts` fills the
  `'pr'` (`gh pr merge --squash`) and `'local'` (`git merge --no-ff`) merge
  bodies — **no `git worktree remove`** (Open uses plain branches). Battle-
  tested Vajra fixes are mapped (see `trident/vajra-fixes.test.ts`): no
  phantom-id poll, no silent exit, loud fail on a missing Ralph
  `REMAINING_TASKS`, the `max_rounds`/`max_ralph_rounds` caps, the
  oversized-diff guard, model-routing defaults, and (PR-5) **restart-resume**
  — an orphaned `subagent_run_id` (untracked after a control-plane restart)
  is recovered by a bounded one-per-process re-dispatch
  (`on_orphaned_session`), never a double-spawn. PR-5 flips production onto
  the live loop: `build-core-modules.ts` wires the real `step` when the
  composer threads `input.trident.dispatch` (else `stubAdvanceDeps`).
- **Tick driver** — `TridentTickLoop` (`trident/tick.ts`), modelled on
  `reminders/tick.ts`: a single-flight `setInterval` (default 90 s, the
  skill's ScheduleWakeup cadence) that loads non-terminal runs and advances
  each. Registered as the `trident` module in
  `gateway/composition/build-core-modules.ts`, started/stopped with the
  graph exactly like the reminders loop.
- **Async result delivery** — when a run transitions into a terminal phase
  (`done` / `failed`), the loop posts the result back to the chat topic the
  build came from. Each run persists its originating `chat_id` / `thread_id`
  at dispatch; on the terminal transition the loop fires its `on_terminal`
  hook (mirroring the reminder loop's `on_fired`): `buildTridentDelivery`
  (`trident/delivery.ts`) composes a per-state result message and posts it
  through the `ChannelRouter`. It is **generic** — keyed on the run's own
  routing fields, not on `/code`, so any background agent that lands a
  `code_trident_runs` row delivers through the same seam; runs with no
  originating chat (`chat_id` null, e.g. cron-seeded) no-op. The hook is
  failure-safe: a posting outage is logged and never un-terminates a
  finished build nor aborts the tick. The composer is a pure function so
  the exact copy per terminal state is unit-tested in isolation.
- **git-mode auto-detect** — `detectMergeMode(repoPath, probe)`
  (`trident/git-mode.ts`): `'pr'` when the repo has a GitHub `origin` AND
  `gh` is available, else `'local'`. Persisted per run; no user config
  (Ryan-locked: build both, auto-detect). `cleanupAfterMerge` dispatches to
  the `trident/merge.ts` bodies (PR-3).

### Ralph build mode (PR-4) — spec-driven, one task per fresh context

For large, spec-driven work, Trident runs in **Ralph mode** (named after
Geoffrey Huntley's "ralph" loop) instead of one big Forge context that drifts
as its window fills. Progress lives in FILES + git history, never a context
window, so a fresh agent each iteration cannot forget what was agreed.

- **Detection** — `detectRalphMode(repoPath, probe, {explicit})`
  (`trident/git-mode.ts`): a run is Ralph when explicitly requested OR the
  repo's git root contains a `SPEC.md` (a "governed" repo).
  `defaultRalphModeProbe` resolves the git root then checks `<root>/SPEC.md`.
  Persisted as `ralph` on the run row; the run-creation call site is
  `trident/code-command.ts` (the `/code` entry, PR-5), which auto-detects
  git-mode + Ralph at dispatch.
- **The loop** (driven by the same tick state machine):
  1. `forge-init` (Ralph bootstrap) — create the branch, write the first
     `IMPLEMENTATION_PLAN.md` (a `- [ ] <task>` checklist derived from
     `SPEC.md`), build ONLY the top task, open the PR, report
     `REMAINING_TASKS`. Prompt: `renderForgePrompt` + `RALPH_BOOTSTRAP_NOTE`.
  2. `ralph-plan` — a FRESH, docs-only planner diffs `SPEC.md` against the
     actual code and rewrites `IMPLEMENTATION_PLAN.md`, reporting
     `REMAINING_TASKS` + `NEXT_TASK`. Prompt: `renderRalphPlanPrompt`; parsed
     by `parseRalphPlan` (no PR contract lines required). The active
     drift-catch: a regressed task re-opens as `- [ ]`.
  3. `ralph-task` — a FRESH Forge implements ONLY the surfaced `NEXT_TASK`
     (threaded via `session.nextTaskFor`), checks it off, updates
     `AS-BUILT.md`, commits. Prompt: `renderRalphTaskPrompt`.
  4. Repeat 2 ⇄ 3 until a planning pass reports `REMAINING_TASKS=0`, then →
     `argus` → the normal fix/merge loop reviews + merges the accumulated
     branch.
- **Fail-loud guard** — a missing/garbled `REMAINING_TASKS` (strict
  `^[0-9]+$`) from the bootstrap OR any planner halts the run (`phase=failed`),
  never silently merges a partial governed build. `max_ralph_rounds`
  (default 20) bounds a non-converging planner so the loop can't spin forever.

Threading the production gateway credential closure into a live
`TridentDispatch` so boot drives the loop (and the run-creation call site that
calls `detectRalphMode`) is PR-5.

## Agent-dispatch reliability — double-spawn guard + agent-aware watchdog (`runtime/subagent/`)

The substrate-agnostic dispatch layer (`runtime/subagent/`) owns the
`SubagentRegistry` of logical dispatched agents (forge / argus / atlas /
sentinel / core), `spawnSubagent` (the validated spawn entry point), the
`control` surface (cancel / wait / status), and the watchdogs. Two reliability
guards close gap-audit §(b) #8 ("watchdog is generic, not agent-aware"):

- **Double-spawn guard (`spawn.ts`).** Each spawn may carry a logical
  `spawn_key` (callers namespace it, e.g. `${instance_key}:${task_id}:${kind}`).
  Step 0 of `spawnSubagent` — before the concurrency/depth checks — consults
  `registry.liveByKey(spawn_key)`; a LIVE (`pending`|`running`) holder means an
  in-flight dispatch already owns this task, so the second attempt **coalesces**
  (returns the existing record — default) or **refuses** (throws), per
  `on_duplicate`. This mirrors the Vajra incident class where a registry-only
  pid that was never killed let two processes attach to one session. A TERMINAL
  record with the same key does not match, so a finished/reaped task can be
  cleanly re-spawned. Omitting `spawn_key` leaves the guard inert (back-compat).

- **Agent-aware watchdog (`watchdog.ts`).** `runAgentWatchdog` is a periodic
  liveness pass over LIVE dispatched agents. For each it detects + SURFACES one
  terminal condition: `process_dead` (a record with a `pid` whose process is
  gone before completion) or `stuck` (no progress past the per-`AgentKind`
  inactivity threshold; default 5 min). Surfacing = mark the run failed via the
  `failRun` control verb (terminal `status='crashed'` + `failure_reason`,
  distinct from a deliberate `cancelRun`) AND emit an `AgentWatchdogEvent`
  (`run_id`, `agent_kind`, `instance_key`, `reason`, `delivery_target`,
  `age_ms`) through an injected `notify` sink — so a crashed/stuck agent is
  reported instead of leaving its awaiter hung forever. A `stuck` agent's
  process is killed (via its canceller) before surfacing; a `process_dead` one
  is already gone. It does not auto-respawn (deferred); the event carries enough
  context for a caller to retry/notify.

The two are complementary: the watchdog reaps a registry-live-but-process-dead
record so a legitimate re-spawn proceeds, while the guard blocks a concurrent
duplicate while the first is genuinely in flight. Both are substrate-agnostic
and injectable (`now` / `pid_alive` / `notify`). The watchdog is the SOLE owner
of live→terminal liveness transitions; `runLifecycleTick` (`lifecycle.ts`)
COMPOSES it — one ordered tick that runs the watchdog first (surfacing stale/dead
agents) then prunes already-terminal records past `cleanup_after`. (Previously
lifecycle reaped `running` records itself, silently and with no notification,
racing the watchdog at the same threshold; folding it into a single ordered tick
removes the race while keeping the established tick entry point reaping liveness.
Omit the watchdog deps for a prune-only tick.) They are library surfaces in S3
(in-process); the gateway wires a periodic tick + the `notify` sink (Telegram /
the `watchdog/` AlertStore) when the registry moves to SQLite-backed
persistence in S4. (Distinct from the OS-process-level `watchdog/` module, which
runs the same liveness idea over `tools/process-registry.ts` for crons/tools.)

## Autonomous overnight work (`onboarding/overnight/`) — runs ON Trident

The real overnight-work engine: while the user sleeps, the highest-priority
queued items for each project are dispatched, **each as its own Trident run**
(Forge→Argus→merge), and a morning brief reports the REAL result of every run.
This is the Neutron-Open (SQLite-native) port of Vajra's
`gateway/overnight-dispatcher.ts`, with the Ryan-locked design correction that
each item is a Trident run rather than a single throwaway substrate turn.

It replaces the old preview-only morning check-in stub
(`onboarding/wow-moment/overnight-cron.ts`, `wow_overnight_handler`), which
delivered a "here's what's on deck" message but never actually ran any work.

**Queue model (chat-driven).** `overnight_queue` (migration
`0078_overnight_queue.sql`) is the runtime source of truth — one row per work
item, keyed by an `owk-YYYYMMDD-NNN` id. The agent maintains each project's
STATUS.md `## Autonomous Overnight Work` block by RENDERING it from these rows
(`status-md-sync.ts`); the user never edits STATUS.md. `overnight_budget` holds
the per-window dispatch counter; in-flight concurrency is computed from the
queue so it can't drift across a restart.

**The `[context:]` hard gate.** Every dispatchable item MUST carry a
`[context:<path>]` resolving to a real file inside the project repo (64 KB cap,
no absolute paths, no `..`, no symlink-escape). Double-enforced at scan +
dispatch; an item with no resolvable context is rejected, never spawned
(`checkContextGate`). Verbatim port of Vajra's hard gate, re-pointed from
`VAJRA_HOME` to the per-project repo root.

**The dispatcher (`dispatcher.ts`)**, driven by the per-project cron
`overnight-<slug>` (action 07, ~30-min tick), runs three branches:
- **SCAN** (only inside the **23:00–07:00 local** window) — reconcile any
  hand-seeded STATUS.md bullet into a real queue row, re-render the
  agent-maintained block, gate `[context:]`, and dispatch the highest-priority
  queued items up to budget (**2 concurrent / 8 per window**, env-overridable
  via `NEUTRON_OVERNIGHT_MAX_CONCURRENT` / `NEUTRON_OVERNIGHT_MAX_PER_WINDOW`).
  Each dispatch creates a `code_trident_runs` row via the Trident store and
  links it onto the queue item (`trident_run_id` / `trident_slug`).
- **ADVANCE** (anytime — items started near 06:30 finish after the window
  closes) — poll each in-flight item's Trident run; on a terminal phase record
  the REAL result (`PR#42` / `merged <branch>` / `failed: <reason>`), write a
  result doc to `docs/overnight/<owk-id>.md` in the repo, mark the item
  terminal, and re-render STATUS.md.
- **REPORTER** (once at **≥06:50 local**) — see the morning brief below.

**Morning brief (`morning-brief.ts`)** reports only items whose Trident run
finished THIS window (`window_date_local`). It NEVER invents results: the
General topic gets a high-level summary (counts + one line per project),
per-project topics get the detail (each completed item's real result + each
failure's reason). A quiet night posts one honest line to General.

**Onboarding makes the promise TRUE.** `ProjectMaterializer` writes
`autonomous_overnight_enabled: true` into every project's STATUS.md
frontmatter and seeds one grounded overnight bullet pointing at a real
`docs/overnight/seed-context.md` it writes from the synthesized project
context — so the engine's scan reconcile adopts it into a real queue row, the
hard gate passes, and the item runs as a Trident run on the first overnight
window.

**Wiring.** `register.ts` builds `overnight_handler` (the real engine) and the
production seams (real-fs STATUS.md IO + result-doc writer, the
`TridentRunStore`-backed Trident seam, opted-in project enumeration over
`<owner_home>/Projects/`); `gateway/composition/build-core-modules.ts`
registers it unconditionally in the production `CronHandlerRegistry`.

**Divergences from Vajra** (intentional): SQLite queue not JSON; cron-driven
not watchdog; each item is a Trident run (Forge→Argus→merge) not a single
substrate turn; documented 2/8 caps not the drifted 4/40; context resolved per
project repo not `VAJRA_HOME`.

**Known gap.** The overnight engine creates + polls REAL `code_trident_runs`
rows today. Whether those rows *advance* end-to-end in production is governed
by the Trident tick loop, which still boots on `stubAdvanceDeps` (classify
always "running") until the gateway credential closure is threaded into a live
`TridentDispatch` — Trident PR-5. Until then a production overnight run is
created + tracked but sits at `forge-init`; the full path (item → driven
Trident run → real result → morning brief) is proven by the overnight test
suite, which drives the run to terminal through the same store the engine
polls.

## Post-onboarding chat surface (`gateway/http/chat-bridge.ts`, `landing/chat.ts`)

Once onboarding reaches `phase==completed`, the chat surface is a normal
live-agent chat on EVERY topic — the General topic (`web:<uid>`) and each
per-project topic (`web:<uid>:<project>`) alike.

**Routing (server).** `handleInbound` gates a typed `user_message`:
`isLiveAgentEligible` returns true iff the onboarding row is `phase==completed`,
and the turn dispatches to `build-live-agent-turn` (the warm per-(project,topic)
CC session) instead of the engine. Project topics route through
`handleProjectTopicInbound`; General routes inline. A `button_choice` TAP always
bypasses this gate and drives `engine.advance` — so the onboarding wow
final-handoff buttons (mobile-app / telegram-bind / skip / done) keep working
even after the topic is live.

> GO-LIVE P0 (2026-06-20): General previously stayed on the engine path while a
> final-handoff prompt was pending (`final_handoff_active === true`). An owner
> who never tapped the handoff "Done" left that flag stuck true forever, so every
> typed General message dead-ended in `noop_terminal` and the topic went silent
> while project topics worked. The `final_handoff_active` gate was removed;
> General now mirrors project topics. Live-agent reply rows persist with a 10-year
> TTL (`build-live-agent-turn.ts`) so history never ghost-expires.

> GO-LIVE (2026-06-20): live-agent turns are SERIALIZED per (instance, topic).
> `build-live-agent-turn.ts` keeps a `turnChains` map (one promise tail per
> topic) and chains each turn's body onto the prior turn's tail, so two messages
> typed in quick succession on the same topic run strictly one-at-a-time and in
> arrival order. Before this, a 2nd turn that arrived before the 1st settled also
> saw `isColdFirstTurn` (the warm session wasn't pooled yet) → both cold-spawned
> a parallel CC session, both emitted the "Waking up…" ack, replies raced /
> duplicated, and one question was lost. Serialization makes the 1st turn
> establish the single warm session (and pay the one cold-start ack); the 2nd
> reuses it and answers its own question in order. Distinct topics keep distinct
> chains and still run concurrently.

**Client surface (`landing/chat.ts`).**
- *First-load loader.* The "Setting things up…" indicator covers a FRESH
  onboarding's page-load → WS-open → first-prompt window and clears on first
  rendered content. A RESUMED returning session (`session_ready` with
  `resumed: true`, stamped by `landing/server.ts` on the cookie-only resume and
  spent-jti fallback paths) clears it immediately — a completed instance emits
  no fresh first prompt, so without this the loader hung forever on reload.
- *Topic switch.* `switchTopic` runs over the live WS (no reload): cache scroll,
  abort the outgoing fetch, clear `#log` + per-topic render state (including the
  on-open typing timeout), send `topic_switch`, await the `topic_switched` ack
  (the server re-emits the active seed prompt first), then hydrate the
  destination's full history via `GET /api/v1/chat/history?topic_id=…`.
  Historical rows render inert (resolved → [agent][user]; unresolved → agent
  bubble), with the single active prompt left for the live re-emit.
- *Wow brief persistence (2026-06-20).* The wow channel adapter's `sendText`
  (`buildWowChannelAdapter`, `gateway/realmode-composer/build-wow-dispatcher.ts`)
  persists every delivered agent statement — notably action 01's first-week
  brief — to `button_prompts` as an inert, already-resolved agent-bubble turn so
  it survives a reload. Best-effort on the success path only (try/catch); it
  never disturbs the load-bearing throw-on-undelivered routing.
- *Truthful first-week brief (2026-06-20).* Action 01's overnight section
  (`appendOvernightPreview`, `onboarding/wow-moment/actions/01-first-week-brief.ts`)
  reads the REAL `overnight_queue` for the project at render time
  (`OvernightQueueStore.listByProject`, filtered to `queued`/`in-flight`). It
  reflects genuinely-queued rows when present, and otherwise OFFERS overnight
  work / reminders rather than asserting a schedule. It never claims scheduled
  overnight work or set reminders unless the real tables back it (owner DB at
  onboarding: 0 queue rows, 0 reminders). Option B (wiring real overnight work
  at onboarding) is a logged post-launch follow-up.
- *No fake unread badge (2026-06-20).* The Open topics surface
  (`open/chat-topics-surface.ts`) reports `unread_count: 0` for every topic.
  There is no per-topic last-read marker, so a real unread count cannot be
  computed; the previous count (unresolved-prompt tally) made every project's
  single opening seed render a perpetual "1". The client badge hides at 0, so no
  fake indicator paints. (Field + client mechanism retained for a future
  real last-read seam.)

## React web chat client (`landing/chat-react/`, Track B Phase 3) — behind a flag

The vanilla-TS client above (`landing/chat.ts`, ~4.5k lines, served on the
legacy `/ws/chat` surface) is the DEFAULT and is untouched. Track B Phase 3
adds a second, React-based web chat surface — the parity-research doc's
recommended stack (**React + `@assistant-ui/react`, MIT, bring-your-own-
transport**) — that reuses the Phase-1 `@neutron/chat-core` sync engine. It
ships **behind a flag with no cutover**; parity is proven before any default
flip.

**Transport.** The React client connects through chat-core's `WebChatSession`
to the **app-ws** surface (`/ws/app/chat`, `app:<user_id>` topic) — the Phase-1
transport with a monotonic per-topic `seq` + `resume after_seq` replay + the
OPFS/wasm local Store. That is a DIFFERENT surface from the vanilla client's
`/ws/chat`; the two run side by side. Identity is derived client-side from the
same start-token `sub` claim the vanilla shell stashes; the app-ws token
defaults to the dev-bypass form (`dev:<user_id>`) and is overridden by
`window.__neutron_app_ws_token` once the production EdDSA mint lands.

**The flag (`landing/web-chat-flag.ts`).** `GET /chat` picks the client via
`resolveWebChatClient({ envDefault, queryClient })` — env
`NEUTRON_WEB_CHAT_CLIENT` (deploy-wide default; `react` opts in) with a
per-request `?client=react|vanilla` override. Default + unrecognized → vanilla.
The React assets are also `existsSync`-guarded, so even with the flag on an
instance that didn't ship them falls back to vanilla rather than 404ing the
chat surface. The React shell (`chat-react.html`) loads `/chat-react.js`, which
the landing server lazily bundles from `chat-react/main.tsx` via `Bun.build`
(minified, ~0.6 MB — React + assistant-ui + chat-core), exactly mirroring the
existing `chat.ts` → `/chat.js` lazy-bundle path.

**Layering (testable seams).**
- `chat-core/web-session.ts` gained one additive, optional `onFrame(frame)`
  observer: the sync layer only persists final `user_message`/`agent_message`s,
  but the UI needs the ephemeral `agent_message_partial` stream + typing hints.
  `onFrame` surfaces every raw frame without touching persistence/ordering, so
  the Phase-1 vanilla wiring is unchanged.
- `chat-react/controller.ts` (`NeutronChatController`) is the framework-agnostic
  data layer: it wraps a `WebChatSession`, accumulates streaming partials into a
  live (not-yet-persisted) agent bubble that the final persisted message
  supersedes, derives `isRunning` (typing) from "awaiting a reply OR streaming",
  tracks connection status + the offline-queue depth, and caches a synchronous
  `ChatViewModel`. The session is injected via a factory, so the controller
  unit-tests against a real `WebChatSession` + a fake socket — real integration
  coverage over the chat-core contract with no DOM.
- `chat-react/message-adapter.ts` is the pure `RenderMessage → ThreadMessageLike`
  mapping (assistant-only `status`, user-only attachments, image-part URL
  absolutization).
- `chat-react/useNeutronChat.ts` is the thin React seam that mirrors the
  controller's view-model into state and builds assistant-ui's
  `ExternalStoreRuntime` (the bring-your-own-transport runtime).
- `chat-react/ChatApp.tsx` composes the UI from assistant-ui **primitives**
  (`ThreadPrimitive`/`MessagePrimitive`/`ComposerPrimitive` — the styled
  `Thread` was removed from the core package in 0.14.x), styled to the existing
  dark theme; topic rail (project tags), connection banner, offline-pending
  badge, streaming typing dots.

**Parity reached:** optimistic send, token streaming, typing indicator,
reconnect+backoff (all via chat-core), durable cold-open + gap-free reconnect
(seq/resume), multi-device (falls out of seq/resume + the Phase-1 `Set<sender>`
registry), project topics, attachment rendering. **Not yet at parity (documented
gaps):** attachment *compose* UI (upload-and-send affordance — rendering is
done; the data path through `WebChatSession.send(attachments)` exists); "load
earlier" history paging beyond the resume replay window; and the production
app-ws token mint for web (the same deferred identity sub-sprint the app-ws auth
resolver itself notes). These are incremental follow-ups; the vanilla client
remains the default until they close.

**Tests.** `chat-react/__tests__/` — controller integration over a real
`WebChatSession`+fake socket, pure adapter + bootstrap-config tests, and a
happy-dom component smoke test that renders the full assistant-ui composition
and asserts an optimistic send + a streamed-then-finalized agent reply reach the
DOM. `landing/__tests__/web-chat-flag.test.ts` + `chat-react-serving.test.ts`
cover the flag + flag-gated `/chat` + `/chat-react.js` serving. The React leaf
typechecks via `landing/chat-react/tsconfig.json` (`bunx tsc -p
landing/chat-react/tsconfig.json`) — isolated from the root deploy gate, which
has no JSX/React; the only chat-react file the root gate sees is the pure
`landing/web-chat-flag.ts` (imported by `server.ts`).

## Onboarding project removal ("ignore X")

At `projects_proposed` the freeform reply routes through the LLM router
(`llm-router.ts`), which extracts a `removed_projects` array; the engine merges
`union(seeded, extracted) minus removed_projects` so a named project is dropped
before materialization. Removal verbs include drop / cut / skip / remove /
**ignore / exclude / leave out / don't set up** (the last four added 2026-06-20
after "ignore real estate investing" was acknowledged but not honored). Projects
are also renameable/deletable later from settings — the prompt copy says so.
