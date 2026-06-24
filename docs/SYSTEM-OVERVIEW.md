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

### Email-Managed Core (`cores/free/email/`)

Tier 1 Gmail Core. Installs against the owner's Google account via a
per-Core OAuth grant (the same per-Core OAuth pattern the Calendar and
Google-Workspace Cores use; tokens live under the distinct `gmail_compose`
secret label so the three Google Cores connect/disconnect independently).
The production backend factory (`gateway/boot-helpers.ts`,
`email_managed_core`) wires `buildGoogleGmailClient` — a hand-rolled Gmail
v1 REST wrapper with a lazy access-token accessor — and falls back to an
in-memory client when the Cores OAuth surface is absent so install still
succeeds.

Eight MCP tools (all capability-guarded + audited):
- **Read:** `email_list` (label, newest-first), `email_read` (one message),
  `email_thread` (a whole conversation via `users.threads.get` — every
  message + derived thread metadata, oldest-first, one round-trip),
  `email_search` (Gmail query syntax), `email_summarize` (Haiku-fast
  structured summary + optional prose brief), `email_triage` (top-5
  ranked inbox triage).
- **Write:** `email_draft_prepare` (drafts.create + the owner 4-point
  INBOX+IMPORTANT+UNREAD label policy) and `email_send` (messages.send +
  the same visibility-label apply). Send carries its own
  `write:email_managed_core.send` capability, distinct from the drafts
  write capability, for clean audit attribution (shipped per the
  2026-06-20 daily-driver gap-audit P0). Reads degrade gracefully when
  unconnected (the in-memory fallback returns an empty mailbox).

Agent-native parity: every read/search/draft/send is also reachable from
chat via `/email` commands (`/email thread <id>`, `/email search <q>`,
`/email summarize <id>`, `/email triage`, `/email draft …`).

## Tab resolver (WAVE 3 tabbed shell) — `tabs/` + `gateway/http/app-tabs-surface.ts`

The project (and global) tab set is resolved **engine-side** so both clients
(mobile RN + web React) consume one source of truth instead of hardcoding
their tabs. `tabs/registry.ts` exposes a `TabDescriptor` (`key`, `label`,
`scope: 'project'|'global'`, `source: 'builtin'|'core'`, `order`,
`mount: { kind: 'builtin'|'webview', target }`) and a
`resolveTabs(scope, cores)` resolver. **BUILTIN descriptors** — Chat /
Documents / Tasks per-project, Admin global — are unioned with
**CORE-contributed tabs** (PR-2): the `project_tab` surfaces of installed
Cores, shaped as `source:'core'`, `key:'core:<slug>'`,
`mount:{kind:'webview', target}` and sorted AFTER the builtins. The registry
stays **pure** (no DB / no package loading) — the HTTP layer resolves which
Cores are installed and passes a `CoreTabContribution[]` in.

Two read-only HTTP routes (Bearer-auth, shared `AppWsAuthResolver` contract):
- `GET /api/app/projects/<project_id>/tabs` → builtins ∪ per-project Cores
  (from `core_installations`); `<project_id>` substituted into Core targets
- `GET /api/app/tabs`                        → builtin Admin ∪ globally-installed
  Cores (from `core_global_installations`)

**Always on — no feature flag** (SPEC Decisions Log, 2026-06-23). The surface
disclaims its routes (returns `null` → 404) only for non-owned paths. Surface
factory: `createAppTabsSurface({ auth, cores?, installations? })` (Core union
is opt-in — omit `cores`/`installations` for a builtin-only surface), plumbed
via `app_tabs_surface` in `AppSurfacesCompositionInput` → `composition.ts` →
`compose.ts` (`appTabs`, mounted ahead of `appProjects`).

### Mobile client consumption (WAVE 3 PR-3)

The Expo project shell (`app/app/projects/[id]/_layout.tsx`) is **registry-driven**:
on mount it fetches `GET /api/app/projects/<id>/tabs` via `app/lib/tabs-client.ts`
and feeds the resolved descriptors into `ProjectTabBar`'s `tabs` prop — no
hardcoded set. `app/lib/project-tabs.ts` (RN-free, unit-tested) maps each
descriptor to a route + active-highlight key: **builtin** descriptors render the
native expo-router leaf (`mount.target` = `chat`/`docs`/`tasks`); **Core**
(`mount.kind:'webview'`) descriptors route to the generic
`app/app/projects/[id]/cores/[slug].tsx` webview (inline `<iframe>` on web,
system browser via `expo-web-browser` on native — no `react-native-webview`
dep). The legacy `PROJECT_TABS` const survives ONLY as the pre-fetch loading
default (and the on-error fallback) — not a flag-gated path. Consequence: the
registry's project builtins are Chat/Documents/Tasks, so the old **Apps
(launcher)** + **Reminders** tabs are no longer top-level mobile tabs once the
fetch resolves (their routes remain, reachable by deep-link); re-adding them is
a `BUILTIN_TABS` change in `tabs/registry.ts`. The web shell consumption is PR-4.

### Web client consumption (WAVE 3 PR-4)

The React web client (`landing/chat-react/`) is now **registry-driven** too.
`chat-react/ProjectShell.tsx` wraps the existing `ChatApp` as the **Chat** tab
and renders the project's tab bar from the same resolver: on the active project
(`vm.projectId`) it fetches `GET /api/app/projects/<id>/tabs` via
`chat-react/tabs-client.ts` (`WebTabsClient` — the web twin of `app/lib/`'s
client, bearer-authed off `config.token`, base URL `config.origin`). `main.tsx`
mounts `ProjectShell` inside the `AssistantRuntimeProvider` (so the chat session
survives tab switches) instead of `ChatApp` directly. Tab content: **Chat** =
the existing `ChatApp`, kept MOUNTED (hidden via `hidden`) across switches;
**Documents** (PR-5) + **Tasks** (PR-8) (builtin) = their real views; any
not-yet-built builtin tab = a "coming soon" placeholder (unbuilt content, NOT a
flag); **Core** (`mount.kind:'webview'`)
= the Core's `project_tab` surface in a sandboxed `<iframe>`, URL scheme-validated
(`sanitizeCoreTabUrl`, http(s) only) before it reaches `src`. The General
(no-project) view has no project tabs, so it stays chat-only. No feature flag —
the resolved tabs render directly; an unreachable resolver degrades to the
guaranteed Chat tab (graceful fallback, not a toggle). CSS lives in
`chat-react.html` (`car-projectshell` / `car-tab*` / `car-tab-frame`). Tests:
`chat-react/__tests__/tabs-client.test.ts` (pure client + URL sanitize) +
`project-shell.test.tsx` (happy-dom: bar renders the resolved set, Chat shows
`ChatApp`, switching to **Documents** mounts the real `DocumentsTab` (PR-5),
switching to a Core tab renders the iframe at the resolved URL).

### Web Documents tab (WAVE 3 PR-5 + PR-6)

The builtin **Documents** tab (`mount.target === 'docs'`) renders
`chat-react/DocumentsTab.tsx` — the web Obsidian-replacement surface inside
`ProjectShell`. As of **PR-6** it is at **web↔mobile parity**: browse · open ·
read · **edit** · comment (PR-5 shipped read+comment; PR-6 added editing). It
adds **no `documents` table**: bodies stay filesystem-backed, served by the
existing gateway docs surface (`gateway/http/app-docs-surface.ts`). The tab is a
three-pane layout — doc **list** (left) · markdown **viewer/editor** (centre) ·
**comments** side-pane (right) — over `chat-react/docs-client.ts` (`WebDocsClient`,
the web twin of `app/lib/docs-client.ts`: bearer-authed off `config.token`, base
URL `config.origin`, wire types re-declared client-side so the bundle stays
gateway-free):

- **List** = `GET /docs/tree` flattened to its markdown leaves (`flattenDocFiles`;
  folders + binaries dropped).
- **Viewer** = `GET /docs/file?path=` rendered as **selectable RAW markdown** in
  a single text node. Anchors are character offsets into the raw content (the
  same bytes the gateway re-anchors against), so the viewer maps the DOM
  selection back to raw offsets (`selectionOffsets`) — pretty-rendering would
  desync offsets from the file, so v1 shows raw text. `buildAnchor` builds the
  excerpt + ±256-byte context, clamped to the gateway's byte caps.
- **Editor** (PR-6) = **Edit** swaps the viewer for a raw-markdown textarea
  seeded from the open file; **Save** = `WebDocsClient.writeFile` →
  `PUT /docs/file` carrying `expected_modified_at` (the open file's mtime) as the
  **optimistic-concurrency baseline**. A concurrent write loses the race with a
  `409 doc_modified_conflict` (`DocConflictError`; Save stays in edit mode, draft
  preserved, prompts a reload) rather than silently clobbering. On success the tab
  adopts the
  server's post-write `modified_at` as the next baseline and reloads comments
  (anchors re-anchor server-side against the new bytes). Mirrors the mobile docs
  tab's editor (`app/app/projects/[id]/docs.tsx`) over the same handler.
- **Comments** = `GET /docs/comments?path=` (active ∪ a muted Resolved group);
  select text → **Comment** → `POST /docs/comments` (root, anchored); expand a
  thread → reply (`/reply`), **Resolve** (`/resolve`), **Escalate to chat**
  (`/escalate`).

**`comments_unavailable` degrades gracefully** (plan §5 VERIFY): when the gateway
has no comment substrate the comments routes return `503 comments_unavailable`;
`WebDocsClient.listComments` catches that one code and resolves to
`{ unavailable: true, threads: [] }` (every other non-2xx still throws), so the
Documents tab **still lists + views docs** and simply hides the comment composer,
showing a one-line note instead of an error. CSS (`cdoc-*`) lives in
`chat-react.html`. Tests: `chat-react/__tests__/docs-client.test.ts` (pure:
routes incl. `writeFile` PUT + the 409 conflict, the 503 gate,
`buildAnchor`/`clampUtf8`/`flattenDocFiles`) + `documents-tab.test.tsx`
(happy-dom: list renders, doc opens, selection→comment post round-trip, the
unavailable gate, and the PR-6 edit→save→PUT + 409-conflict flows).

**Obsidian retired (WAVE 3 close-out, PR-6).** With web edit parity shipped, the
per-project **Documents tab is the primary and only daily doc surface** on both
web and mobile. No daily-driver doc flow depends on Obsidian: doc bodies are
filesystem-backed (`<owner_home>/Projects/<id>/docs/`), the agent reads them via
`doc_search`/`doc_read` over the FTS index, and the app reads/edits/comments over
`gateway/http/app-docs-surface.ts`. The remaining `obsidian` mentions in the tree
are either accurate "Obsidian-replacement" labels on this surface or the operator
platform's *separate* vault-deeplink convention (the `vault.example.test`
redirector for the owner's own notes) — neither is part of a project's document
flow.

### Web Tasks tab (WAVE 3 PR-8)

The builtin **Tasks** tab (`mount.target === 'tasks'`) renders
`chat-react/TasksTab.tsx` — a dynamic React/AJAX list of the project's tasks
inside `ProjectShell`, with agent+user-parity CRUD (add / complete / reprioritize
/ cancel / delete). It adds **no gateway/backend changes**: it reads + writes over
the existing project tasks surface (`gateway/http/app-tasks-surface.ts`) through
`chat-react/tasks-client.ts` (`WebTasksClient`, the web twin of
`app/lib/tasks-client.ts`: bearer-authed off `config.token`, base URL
`config.origin`, wire types re-declared client-side so the bundle stays
gateway-free).

- **Order is the engine's.** The list fetches with `order=focus_score`, the PR-7
  LLM-primary prioritized ordering (`tasks/prioritize-llm.ts`): ranked rows first
  by `llm_rank`, fresh rows interleaved by `focus_score`. The tab NEVER re-sorts —
  `tasks/store.ts` is the single source of truth — so what the agent ranked is
  what the user sees. Each row surfaces its `llm_rank` (`#N`) and the LLM's
  one-line `llm_reason`.
- **Agent + user parity.** Every action hits the same canonical `TaskStore` the
  agent's `cores/free/tasks` backend writes; the server returns the canonical row
  and the list re-fetches after every mutation. **Reprioritize** is a PATCH of the
  0-3 `priority` field (the column the focus-score reads), so a user nudge feeds
  the next prioritize pass. Open tasks **Cancel** (soft); already-closed rows
  **Delete** (hard). A status filter toggles Open ⇄ All.
- **Robustness.** A monotonic `listSeq` guard drops a slow fetch that lands after
  a newer one; a per-row `busyId` guard blocks double-fires; a project-change
  reset clears a stale list so project A's tasks never linger under project B.

No feature flag — the tab renders directly. CSS (`ctask-*`) lives in
`chat-react.html`. Tests: `chat-react/__tests__/tasks-client.test.ts` (pure:
routes incl. the `order=focus_score` default, `priorityLabel`/`clampPriority`/
`formatDue`) + `tasks-tab.test.tsx` (happy-dom: prioritized server order with
rank+reason, complete, reprioritize PATCH, add).

### Cores install-SCOPE (WAVE 3 PR-2)

A Core installs **per-project** (`core_installations`, keyed
`(project_slug, core_slug)`) OR **globally** (`core_global_installations`,
keyed `core_slug` — added in migration `0084`). The manifest's optional
`install_scopes: ('project'|'global')[]` (omitted ⇒ project-only) declares
which scopes a Core permits; the global lifecycle gates on it. Global CRUD
lives on `CoreInstallationsStore` (`recordGlobal` / `getGlobal` / `listGlobal`
/ `listGlobalLive` / `markGlobalUninstalled`) and the lifecycle exposes
`installCoreGlobally` / `uninstallCoreGlobally` (project-agnostic: no per-
project data namespace or secrets prompt — those still flow through the
per-project `installCore`).

## Tasks — canonical store + LLM-primary prioritization (`tasks/`)

The `tasks` table (migration `0032`) is the single source of truth for tasks
across every surface — agents (via the `@neutronai/tasks-core` Core), the app's
`/api/app/projects/<id>/tasks` HTTP surface, the chat commands, reminders, and
the overnight-work auto-tasker all write through one `TaskStore` (`tasks/store.ts`).
STATUS.md / ACTIONS.md are read-only projections (`tasks/projection/`). The
interim WAVE-2 markdown task port (a `task-inbox.jsonl` append-queue scanned
into `tasks.md` / `DASHBOARD.md`) was **retired** in WAVE 3 PR-9 — the SQLite
store plus the web Tasks tab are the surface; the only markdown projection that
remains is STATUS.md / ACTIONS.md.

**Prioritization is LLM-primary, deterministic-fallback** (WAVE 3 PR-7). Two
ranking signals coexist:

- **Deterministic `focus_score`** (`tasks/focus-score.ts`, migration `0037`) — a
  pure function of `(priority, due_date, staleness)`, stamped synchronously on
  every score-affecting write and re-converged by the 4-hourly
  `tasks.focus_score_recompute` cron. It is the **fallback** ranking and the
  prior shown to the LLM.
- **LLM ranking** (`tasks/prioritize-llm.ts`, migration `0085`) — the
  `tasks.prioritize_llm` cron (6h default) hands the open backlog to an LLM that
  returns an explicit ordering + a one-line rationale, stamped onto `llm_rank` /
  `llm_reason` / `prioritized_by` / `prioritized_at`. This is the **primary**
  mechanism. There is no flag: the deterministic path runs ONLY when no LLM
  credential is wired, or the call throws / times out / returns an
  unparseable·empty·out-of-domain ranking — in which case the same pass ranks by
  `focus_score DESC` and stamps `prioritized_by='deterministic'`.

The two meet at the store's **`'focus_score'` sort order**, which now ranks each
row by its *effective rank*: a ranked row uses its `llm_rank`; a row created
since the last pass (`llm_rank` NULL) is interleaved by `focus_score` (slotted
right after the ranked rows it outranks on `focus_score`) so a freshly-captured
urgent task competes with the ranked set instead of being buried until the next
pass. Each pass clears + re-ranks the full open set, so no row keeps a stale rank.
Every surface already requests this order, so the LLM ranking flows to every
rendered list with no per-caller change; with no rows ranked yet it degrades to
pure focus-score ordering. The
prioritize cron is wired in `gateway/composition/build-core-modules.ts` behind
`tasks.enable_task_prioritize_cron` + `tasks.task_prioritizer.llm` (mirrors the
focus-score / nudge-engine gates); registering it with a null llm is safe — the
handler runs the deterministic fallback until a credential exists.

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

## Entity-page memory + provisioning (GBrain) — `@neutronai/gbrain-memory`

The per-instance long-term memory: entity pages + a typed-edge graph, backed by
GBrain (`gbrain serve` over stdio MCP). Provisioned at boot by
`gateway/realmode-composer/build-gbrain-memory.ts#buildGBrainMemory`, which
returns the live trio the composer threads in — the `client`, the admin
"Memory" tab `memoryStore`, and the entity-writer `syncHook` (pages + graph
fan-out). `resolveGbrainClientOptions` is the pure config seam: it scopes the
`gbrain serve` child to `<owner_home>/gbrain` (`GBRAIN_HOME`) and forwards the
optional operator `GBRAIN_SOURCE` / `GBRAIN_BRAIN_ID`.

- **Default — keyword + graph, NO embeddings.** Memory search runs on GBrain's
  BM25 keyword index + the typed-edge graph. No embedding/vector store
  initializes; provisioning and search need no external embedder. This is the
  shipped default and is unchanged.
- **Conditional embedding store (OPT-IN) — `gbrain-memory/embedder-config.ts`.**
  `resolveEmbedderConfig(env)` returns an embedder config **only** when the
  operator opts in via `NEUTRON_EMBEDDINGS`:
  - `openai` → cloud `text-embedding-3-large` (3072d); key from
    `NEUTRON_EMBEDDINGS_OPENAI_API_KEY`, else `OPENAI_API_KEY`.
  - `ollama` → local/free `nomic-embed-text` (768d) over `OLLAMA_BASE_URL`
    (default `http://localhost:11434/v1`).
  - `auto` → OpenAI when a key is present, else Ollama when `OLLAMA_BASE_URL`
    is set.
  - `off` / unset → `null` (the default — no store).

  A non-null result is the child env (`GBRAIN_EMBEDDING_MODEL` =
  `provider:model`, `GBRAIN_EMBEDDING_DIMENSIONS`, provider auth/base-url),
  which `resolveGbrainClientOptions` merges into the `gbrain serve` child so
  GBrain initializes its embedding store and hybridSearch goes semantic. A
  `null` result leaves the child env untouched — keyword + graph exactly as
  today. A bare `OPENAI_API_KEY` (consumed by the GPT LLM adapter) does **not**
  enable embeddings; the explicit `NEUTRON_EMBEDDINGS` opt-in keeps cloud
  embedding cost from ever being a surprise.

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

## Delivery + read receipts (Track B Phase 4) — `@neutron/chat-core` + app-ws

The per-message delivery ladder — **`pending → sent → delivered → read`** —
across the web + mobile chat stack, built ON the chat-core engine (the sync
engine is NOT forked). Scope is receipts only.

- **Two acknowledgement kinds.** `delivered` is **server-tracked**: when the
  gateway fans a message out it records a `delivered` receipt for every device
  connected at that instant and stamps the set inline on the envelope
  (`delivered_by`). `read` is **explicit**: a client sends `{type:'receipt',
  state:'read', message_id}` when a message is viewed, and the gateway
  attributes it to the SOCKET's device id (never client-supplied — no forging).
  The agent loop also marks an inbound user message `read` (synthetic `agent`
  device) the moment it picks it up, so a single-device sender gets the blue
  read tick without a second device.
- **`receipt_update` fan-out (full aggregate).** Each read records + re-fans a
  `receipt_update` carrying the WHOLE current `delivered_by[]`/`read_by[]` (not
  a delta). The client merges by **set-union**, so apply is idempotent +
  order-independent — the same contract message apply uses; a device can never
  un-deliver or un-read. A resume replays one `receipt_update` per
  message-with-receipts after the cursor.
- **Stored in the Store contract, engine untouched.** `ChatMessage` gains
  optional `delivered_to`/`read_by`; `mergeMessage` set-unions them
  (`unionDeviceIds`); `SyncEngine.applyReceiptUpdate` is an additive method
  over the existing UPSERT path (no-op if the message isn't local yet — a
  receipt never precedes its message on the wire). Both backends persist it:
  RN op-sqlite via two JSON columns + an idempotent `ADD COLUMN` migration;
  web in-mem/OPFS for free.
- **Server (`channels/adapters/app-ws/`, `gateway/http/app-ws-surface.ts`,
  `persistence/app-chat-receipts.ts`).** `AppChatReceiptStore` (migration
  `0082_app_chat_receipts.sql`) keeps one row per `(topic, message, device)` —
  `read` implies `delivered`, monotonic, seq resolved from the message log for
  resume ordering. The adapter gains a `receipt_log` option, delivered-at-fan-out
  stamping, `recordReceipt` (read → persist + fan), and `replayReceiptsAfter`;
  the registry tracks per-session `device_id`; the surface mints/parses a
  `device_id` at upgrade, handles the `receipt` inbound, auto-reads on the WS +
  HTTP send paths, and replays receipts after a resume.
- **Clients.** chat-core sessions add `device_id` + `receipt_update` handling +
  `markRead(ids)`. Mobile (`ChatSyncSurface`) extends the ladder with `read`
  (blue ✓✓), reports agent messages read via `onViewableItemsChanged`, and
  excludes the sender's own device. React/assistant-ui surfaces a Telegram-style
  delivery status line. Like Phase-1's `chat_log`, `receipt_log` is an additive
  adapter option — wired in tests + composers, not yet in the live gateway
  composition (the app-ws surface itself isn't productionised there yet).

## Message reactions (Track B Phase 4, slice 3) — `@neutron/chat-core` + app-ws

Per-message emoji reactions across the web + mobile chat stack, MIRRORING the
receipts slice above (per-message metadata, multi-device sync over chat-core,
socket-attributed, durable + resume-replayable, sync engine NOT forked).

- **Why it isn't just receipts-with-emoji: reactions are REMOVABLE.** Receipts
  only advance, so the client merges them by monotonic **set-union**. A reaction
  can be added AND removed, which a union can't express. So the model is
  **server-authoritative full-aggregate + last-writer-wins by a monotonic
  per-message `rev`**: each add/remove bumps `rev` and re-fans the WHOLE current
  reaction set as a `reaction_update`; the client keeps the highest-`rev`
  aggregate and drops stale ones — idempotent + order-independent, and a
  higher-`rev` EMPTY set is what clears a reaction. Resume replays one
  `reaction_update` per message-with-reactions after the cursor.
- **No forging.** A client sends `{type:'reaction', message_id, emoji,
  action:'add'|'remove'}`; the gateway attributes it to the SOCKET's `device_id`
  (never the frame). `sanitizeReactionEmoji` bounds the emoji to one grapheme
  (no whitespace/control, ≤64 chars; no fixed allowlist so the client owns the
  palette).
- **Stored in the Store contract, engine untouched.** `ChatMessage` gains
  optional `reactions`/`reactions_rev`; `pickReactionState` (rev-LWW, NOT a
  union) is folded into `mergeMessage`; `SyncEngine.applyReactionUpdate` is an
  additive method over the existing UPSERT path (no-op if the message isn't
  local yet or the update is stale). RN op-sqlite persists via a `reactions`
  (JSON) + `reactions_rev` (INTEGER) column pair + idempotent `ADD COLUMN`
  migration; web in-mem/OPFS for free.
- **Server (`channels/adapters/app-ws/`, `gateway/http/app-ws-surface.ts`,
  `persistence/app-chat-reactions.ts`).** `AppChatReactionStore` (migration
  `0083_app_chat_reactions.sql`) keeps one row per `(topic, message, device,
  emoji)`; a remove flips `active = 0` (a TOMBSTONE, not a DELETE) so `MAX(rev)`
  stays monotonic across removes; seq resolved from the message log for resume.
  The adapter gains a `reaction_log` option, `recordReaction` (persist + fan),
  and `replayReactionsAfter`; the surface handles the `reaction` inbound
  (device from the socket) and replays reactions after a resume.
- **Clients.** chat-core sessions add `react(id, emoji, action)` +
  `reaction_update` handling. Mobile (`ChatSyncSurface`) renders per-bubble
  reaction chips (count + self-highlight, tap to toggle) + a long-press
  quick-emoji tray; the shared `groupReactions` derivation produces the chips.
  React/assistant-ui (`landing/chat-react/`) renders per-bubble chips + an
  add-reaction palette via a `ReactionsContext` + assistant-ui's `useMessage()`.
  Like `receipt_log`, `reaction_log` is an additive adapter option — wired in
  tests + composers, not yet in the live gateway composition.

## `/code` → foundational Trident (runtime DONE — prod-boot wiring in progress)

The ~5-PR port folding Vajra's full Trident into Neutron Open as foundational
runtime is **runtime-complete**: the state machine, tick loop, real
Forge→Argus→merge `step`, git-mode auto-detect, Ralph loop, and restart-resume
all land in `trident/` and pass end-to-end against scripted dispatches. The
production filter `buildTridentCodeChatCommandFilter` parses `/code <task>` and
CREATES a `code_trident_runs` row (`trident/code-command.ts`); the tick loop
drives it build → review → fix loop → merge → done (or the Ralph plan↔task loop
for governed repos). State in SQLite ⇒ restart-safe + resumable.

**Prod-boot wiring — what's live in the Open self-host gateway:**

- **The production runner (DONE — this PR).** The Open composer
  (`open/composer.ts`) now builds a dedicated `cc-trident-*` CC-subprocess
  substrate and threads `composition.trident = { dispatch }` (via
  `buildSubstrateTridentDispatch`, `trident/substrate-dispatch.ts`). That is
  what flips the tick loop from its `stubAdvanceDeps` no-op to the real
  `buildTridentOrchestrator` step in `build-core-modules.ts`. Before this, the
  Open composer never set `input.trident`, so a `/code` build would have hit the
  loop's no-op (the `CodegenNotConfiguredError` "production runner not wired"
  class). `buildSubstrateTridentDispatch` runs ONE Forge/Argus turn on the
  substrate to terminal text — all prompt rendering + verdict parsing stay above
  it in the orchestrator + session manager.
- **The `/code` command surface (NEXT PR).** Routing the literal `/code`
  keystroke from the Open landing chat into `buildTridentCodeChatCommandFilter`
  is NOT yet wired — the landing chat path (`landing/server.ts` →
  `chat-bridge.ts:handleInbound`) has no `ChatCommandFilter` seam (that seam
  exists only on the `app-ws-surface`, which Open does not mount). Wiring an
  optional `chatCommandFilter` hook into the chat-bridge (mirroring the existing
  `liveAgentTurn` / `scribeOnUserTurn` hooks) is the next scoped PR.
- **Hardening (FOLLOW-UP).** `buildSubstrateTridentDispatch` runs each turn on a
  warm substrate instance pinned to `owner_home`. Per-build context isolation (a
  fresh subprocess/session per Forge↔Argus turn) and native per-worktree cwd
  (`AgentSpec` carries none today) are deliberate follow-ups, not this PR.

See "Trident — the foundational autonomous-build runtime" above for the boot
wiring.

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
  (`on_orphaned_session`), never a double-spawn. `build-core-modules.ts` wires
  the real `step` when the composer threads `input.trident.dispatch` (else
  `stubAdvanceDeps`); the Open self-host composer threads it via
  `buildSubstrateTridentDispatch` over a `cc-trident-*` substrate (this PR — see
  "`/code` → foundational Trident" below).
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

It superseded the old preview-only morning check-in stub
(`wow_overnight_handler`), which delivered a "here's what's on deck" message
but never ran any work. That stub (`onboarding/wow-moment/overnight-cron.ts`)
was removed in the 2026-06-22 overnight-dispatcher disentangle once the real
engine was the only registered `overnight_handler`; the composition's delivery
seam (`onboarding_overnight_cron.deliver`, renamed from
`onboarding_wow_overnight_cron`) now feeds the real engine's morning brief.

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

**First-turn system-prompt composition (`composeFirstTurnPrompt`).** The cold
first turn on a (instance, topic) assembles the system prompt that anchors that
topic's warm CC session (subsequent turns ride the REPL transcript and send only
the user text). Layer order, top to bottom:
1. `base_persona` — the owner's generated SOUL/USER/priority-map (`personaLoader`),
   or a generic fallback when none exist. This is "who you are."
2. `<operating_doctrine>` — gap-audit item 10: the owner-AGNOSTIC "how you act on
   every turn" doctrine (`gateway/realmode-composer/operating-doctrine.ts`):
   truth-first, essence-over-excess, calibrated confidence, explicit
   anti-sycophancy / pushback discipline, and a grounding ("dharma") reframe used
   only when it genuinely fits. Composed consistently on EVERY topic, independent
   of whatever the generated SOUL text happened to contain, and per-context
   weighted (General → cross-project breadth; a project topic → that project's
   craft, lighter reframes). It is a FLOOR, not a ceiling — the fragment defers to
   any sharper rule the owner's SOUL states. Spliced into both the assembled path
   and the degraded fallback, so the floor never depends on `assembleSystemPrompt`.
3. `<project_persona>` — WAVE 2 Track A: a project topic's own `projects.persona`
   voice, refining the register for that project (never for General).
4. `<live_agent_context>` — the this-turn scope block + a `<recent_conversation>`
   short-term-memory splice.

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

## Reflection — diary + corrections-log (`reflection/`)

The lightweight **reflection + learning layer**. It complements the memory
subsystems — scribe (`scribe/`) + GBrain (`gbrain-memory/`) + the entity-writer
wiki capture durable *entity* knowledge; reflection is the *self-improvement*
loop (Vajra's diary + `corrections-log.md` mechanism, Neutron-native for a
self-hoster). Storage is mechanical + deterministic (plain append-only markdown
under `NEUTRON_HOME`, no DB); the only LLM step is judging "was this a
correction?".

- **Diary** (`diary-store.ts`) — append-only, per-UTC-day markdown at
  `<NEUTRON_HOME>/diary/<YYYY-MM-DD>.md`; the agent's own short reflections.
- **Corrections-log** (`corrections-store.ts`) — one append-only markdown file
  `<NEUTRON_HOME>/corrections/corrections-log.md`; each correction a `## ` block
  with `wrong` / `right` / `why` / `scope` / `source`. Human-readable AND
  round-trip-parseable.
- **Detector** (`detector.ts`) — `looksLikeCorrection` (deterministic keyword
  pre-gate; skips the LLM on ordinary turns) → `detectCorrection` (LLM judge over
  the CC-spawn substrate, final say + distils the learning).
- **Context** (`context.ts`) — renders recent corrections + diary into a
  `<learned_corrections>` / `<recent_diary>` block (apply SILENTLY).
- **Factory** (`index.ts`) — `createReflection({ ownerDataDir, substrate? })`.

**Wiring.** `open/composer.ts` builds a dedicated ephemeral `cc-reflection-*`
judge substrate and threads the `Reflection` into `buildLiveAgentTurn`. On each
(instance, topic) the FIRST turn splices `loadContext()` into the system prompt
(so the warm session adopts past corrections and applies them silently); every
completed turn fires `onTurnComplete(...)` → pre-gate → judge → log + diary
breadcrumb. LLM-less self-host: omit the substrate → detection OFF, diary +
read-back still work. Every hook is best-effort and never throws into the chat
path.

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
  badge, streaming typing dots, and the attachment compose affordance
  (file-picker + drag-drop, removable staged chips, attachment-only send).
- `chat-react/ProjectShell.tsx` (WAVE 3 PR-4) is now the component `main.tsx`
  mounts inside the runtime provider — it wraps `ChatApp` as the Chat tab and
  renders the registry-resolved tab bar (see "Web client consumption" above).
  `ChatApp` itself is unchanged.
- `chat-react/uploads.ts` + `chat-react/useAttachmentDraft.ts` are the
  attachment seam. Compose uploads go to the EXISTING bearer-authed
  `POST /api/app/upload` surface (`gateway/http/app-upload-surface.ts`, shared
  with the Expo client — no new backend); the returned content-addressed URL is
  staged in the draft and ridden out on the next send via
  `WebChatSession.send({ attachments })`. Because the matching
  `GET /api/app/upload/<user>/<hash>.<ext>` is ALSO bearer-authed (a leaked URL
  reveals only one user's blobs), a plain `<img src>` would 401 — so a custom
  assistant-ui `Image` content-part fetches the blob WITH the app-ws token and
  renders an object URL. The bare token is surfaced on `BootstrapConfig.token`.

**Parity reached:** optimistic send, token streaming, typing indicator,
reconnect+backoff (all via chat-core), durable cold-open + gap-free reconnect
(seq/resume), multi-device (falls out of seq/resume + the Phase-1 `Set<sender>`
registry), project topics, and attachments (compose **and** authed render).
**Not yet at parity (documented gaps):** "load earlier" history paging beyond the
resume replay window — this is the one remaining named-scope gap, and it is NOT
client-only: chat-core + the app-ws surface are forward-only (a single
`{type:'resume', after_seq}` replay, `replayAfter` ASC capped at 500), so there
is no backfill primitive to page OLDER messages. Closing it is an additive
cross-layer change (a `replayBefore`/`{type:'history', before_seq}` request on
the app-ws surface + persistence + a `WebChatSession.loadEarlier()` correlation
+ a controller cursor + a "Load earlier" button) that must not destabilize the
Phase-1 forward-only resume contract — deferred to its own reviewed sprint. Also
deferred: the production app-ws token mint for web (the same identity sub-sprint
the app-ws auth resolver itself notes). The vanilla client remains the default
until these close.

**Tests.** `chat-react/__tests__/` — controller integration over a real
`WebChatSession`+fake socket, pure adapter + bootstrap-config tests, and a
happy-dom component smoke test that renders the full assistant-ui composition
and asserts an optimistic send + a streamed-then-finalized agent reply reach the
DOM. `chat-react/__tests__/uploads.test.ts` covers the upload client (bearer
multipart POST, pre-flight size/type rejection, server error codes, abort,
authed GET→object URL) and `attachments.test.tsx` the full stage→upload→send→
authed-render flow. `landing/__tests__/web-chat-flag.test.ts` + `chat-react-serving.test.ts`
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

## Testing & CI — the bounded-memory partitioned runner (`scripts/run-tests.sh`)

CI runs `bash scripts/run-tests.sh` (`.github/workflows/ci.yml`), the one
documented command for the **whole** suite. `bun test` loads every file into one
long-lived process whose peak RSS OOMs the contended 30 GB deploy box (ISSUES
#78); the runner **partitions** the ~775 files into chunks and runs each chunk in
its own fresh `bun test` process, so peak RSS is bounded to a single chunk and
freed between chunks. Coverage is **audited** — every discovered file runs once,
cross-checked against bun's own discovery count; drift is a fatal error, never
silent truncation. For a single file, bare `bun test <file>` is fine.

- **PGLite-WASM quarantine lane (ISSUES #79 / #327).** The handful of test files
  that boot a real Postgres-in-WASM (`@electric-sql/pglite`) run in their **own
  dedicated lane after** the general chunks: serial (`--max-concurrency=1`, so two
  brains never compile WASM at once — the #79 boot race) with a **bounded retry
  budget** (a transient WASM-init failure re-runs the whole lane a few times
  before the run fails). Lane membership is content-derived (any file mentioning
  `pglite`), so new PGLite tests are quarantined automatically; lane files still
  count toward the coverage audit.
- **Tuning.** Peak RSS ≈ `NEUTRON_TEST_JOBS` × `NEUTRON_TEST_CHUNK_SIZE` ×
  per-file working set. Contended box / CI: `CHUNK_SIZE=60 JOBS=1` (bounded
  memory). Quiet dev box: `JOBS=4` (faster, more RAM). Full knob matrix +
  recipes in `docs/testing-runner.md`.
