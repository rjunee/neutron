# System Overview

High-level map of how Neutron Open boots and where the major runtime
pieces live. Keep this short; deep detail belongs in `docs/AS_BUILT.md` (and the
archived history in `docs/research/AS-BUILT-archive-2026-07.md`) and the
per-module headers.

## Boot path

The shared shell is `gateway/index.ts:boot()`: it opens the per-instance
SQLite DB, applies migrations, then composes the module graph from a
**graph composer** the caller supplies. The composer produces a
`CompositionInput` → `composeProductionGraph` (`gateway/composition.ts`)
wires the channel router, MCP/tool registry, HTTP surfaces, and the
bundled Cores. Two different entrypoints hand `boot()` that composer:

- **`bun run start` → `open/server.ts`** is the real Open self-host
  entrypoint (root `package.json` `start` script). It resolves single-owner
  config (`NEUTRON_HOME`, owner slug), builds the Open composer
  (`open/composer.ts` `buildOpenGraphComposer`), and calls
  `boot({ composer })` directly — this is the full onboarding + chat +
  WebSocket product on one port, **not** a healthz-only shell. This is what
  a fresh self-host actually runs.
- **Bare `gateway/index.ts` run directly** (its own `import.meta.main`
  entry — Managed's systemd unit, or a raw dev/smoke invocation) resolves
  its composer via the `NEUTRON_GRAPH_COMPOSER_MODULE` env seam
  (`loadGraphComposerFromEnv`). Managed deploys point that env at the
  private `provisioning/realmode-composer.ts`. Run this entry with the env
  unset — which is NOT how Open self-hosters start the server, but is how
  a bare `gateway/index.ts` invocation behaves — and it boots only a
  `/healthz` dev shell (`open/server.ts` guards against this: it first
  checks `NEUTRON_GRAPH_COMPOSER_MODULE` itself so a Managed checkout can
  still safely run `bun start`, then falls back to the Open composer
  instead of an empty one).

### Scope reconciliation — the boot step between migrations and composition

Between "apply migrations" and "compose the graph", `boot()` runs
`reconcileInstanceScopeOnProjectDb` (`migrations/scope-rekey.ts`). It exists
because an instance's `url_slug` is RENAMEABLE while ~38 tables are scoped by
it: the slug is resolved once at boot and handed to the whole module graph, so
after a rename every pre-rename row is stranded under the old key while the
running process reads the new one. `onboarding_state` is the damaging case —
the composer's `isOnboardingActive` fail-closes on a miss, so a `completed`
owner reads as still onboarding, which permanently defers the bundled-ritual
sweep and pins the onboarding preamble + answer-extractor onto every turn
(ISSUES #451).

The repair migrates stranded rows FORWARD onto the boot slug rather than moving
the key: the boot value is load-bearing for auth equality (`open/wiring/owner-gate.ts`
and `landing/auth-gate.ts` compare the session cookie to it), and a self-host has
no frozen handle to key on instead. `instance_scope_ledger` (migration 0114) is a
singleton recording which key the DB is scoped to, so the common boot is a single
SELECT; a disagreement (or an absent ledger, whose stale keys are discovered from
`onboarding_state` as the anchor table) triggers a `VACUUM INTO` snapshot followed
by one `BEGIN IMMEDIATE` transaction that moves the rows and writes the ledger
last — crash-safe and idempotent by construction. Collisions resolve to the
current-key row, except in `onboarding_state`, where the more authoritative row
(terminal phase, then greater `last_advanced_at`) wins so a post-rename fresh row
can never shadow `completed`. Columns naming ANOTHER instance are explicitly
excluded; `migrations/__tests__/scope-sweep-coverage.test.ts` forces every new
slug-ish column to be classified as swept or excluded.

## Cores

Bundled Cores live under `cores/free/`. Each Core's production runtime is
assembled by a single wiring entrypoint that the composer calls, and its
MCP-tool backend is threaded through `buildCoresBackendFactories`
(`gateway/boot-helpers.ts`) so the chat-command filter and the MCP tools
share one backend instance. Examples:
- Research: `buildProductionResearchCoreWiring` (in-Core).
- Code-Gen: NO gateway wrapper — `/code` is foundational Trident over the
  CC-subprocess substrate (see "`/code` → foundational Trident" below). The old
  gateway wrapper (`buildProductionCodegenCoreWiring` + the direct-SDK
  `code-gen-factory.ts`) was retired 2026-06-24. The `cores/free/code-gen/` Core
  engine survives only as the four legacy `codegen_*` MCP tools.
- Calendar (`cores/free/calendar`, `@neutronai/calendar-core`): per-Core
  Google OAuth (manifest `oauth_token` slot, label `google_calendar`, scope
  `…/auth/calendar`) shared with Email + Google Workspace via the
  `OAuthTokenManager` — NOT a global token. `buildGoogleCalendarClient`
  (Calendar v3 REST, no SDK dep) is wired in `gateway/boot-helpers.ts`
  through that accessor; when the Cores-OAuth surface is unmounted it falls
  back to `buildInMemoryCalendarClient` so install still succeeds (graceful
  degradation). CRUD lives behind nine MCP tools (`calendar_list/create/
  update/cancel/…`) AND the `/cal` chat commands — agent-native parity. The
  `/cal` filter is surfaced via `buildCalendarChatCommandFilter`
  (`gateway/boot-helpers.ts`, re-exported from the `gateway` barrel) so the
  composer chains it into `buildChainedChatCommandFilter([...])` alongside
  `/remind` and `/code`.
> **Notes / second-brain core — REMOVED (2026-07-01).** The former
> `cores/free/notes` (`@neutronai/notes`) package — a second-brain port that
> shipped a per-project `notes.db` sidecar + eight `notes_*` MCP tools + the
> `/note` chat command — was ripped out. It was made redundant by the
> second-brain→GBrain rip-replace: **GBrain is now the SOLE per-owner memory
> store** (see “Entity-page memory + provisioning (GBrain)” below). Nothing in the
> runtime reads the old notes tables; the historical per-Core migration is a
> no-op orphan on any already-deployed DB.

**Narrow Neutron chat commands (`/status`, `/reset`).** Beyond the Core `/`-commands
(`/remind`, `/code`, `/cal`, `/email`, `/research`, `/skills`), Neutron ships a
deliberately narrow set of instance commands — NOT the full the legacy harness topic-lifecycle
vocabulary (Ryan 2026-07-21: "only the chat commands that make sense for
Neutron"). `/status` (M2 task 3) is a pure READ that replies with a deterministic
one-shot snapshot — active project, current model (`getBestModel()`), pending
reminder count, active work-board items, and active Trident builds. It is built by
`buildStatusChatCommandFilter` (`gateway/boot-chat-command-filters.ts`, re-exported
from the `gateway/boot-helpers.ts` barrel) and chained in `open/composer.ts` into
the SAME `buildChainedChatCommandFilter([...])` the web onboarding chat AND the
app-ws chat share, so there is one command path. The snapshot itself is an injected
thunk (the composer binds it — via a `late<T>` two-phase holder — to the live
projects reader / reminder store / work-board / Trident run store once those stores
exist), keeping the filter store-free and unit-testable. The command word is exact:
`/statusfoo` falls through to the LLM (K8 grammar boundary). `/reset` (M2 task 4) is
the sibling command, built by `buildResetChatCommandFilter` and chained into the
SAME command path. It behaves like sending Claude Code's own `/clear` to the live
chat REPL: on a matched `/reset` the composer's injected thunk calls
`resetPooledSessionContext` (`runtime/adapters/claude-code/persistent/context-reset.ts`),
which actuates `CONTEXT_RESET_COMMAND` (`/clear`) against the warm `cc-agent-*` REPL
for the turn's project scope (`'general'` when no project) UNDER the session's
`acquireTurn` mutex — clearing the model's transcript while the `claude` process
(its MCP servers / dev-channel / system prompt) stays alive and keeps serving turns.
It is deliberately NOT a respawn: `respawnSupervisedSession` was verified to always
`--resume` (context-PRESERVING), the wrong primitive. A reset arriving mid-turn
waits up to `acquire_wait_ms` (8 s) for the turn to settle; still busy → an honest
deferral reply that clears nothing (and never wedges the mutex — the abandoned slot
self-releases); no warm session → an honest `no_live_session` reply. Rehydration is
per-session UNDER the mutex: the composer threads an `on_reset_under_mutex` callback
into `resetPooledSessionContext` that emits the turn's project scope on the context-
reset bus (see **Layer B** below) the instant EACH session's `/clear` lands — so a
multi-session reset that clears one session then hits `busy`/`reset_failed` on a
later one STILL rehydrates the already-cleared session (round 4; the earlier
aggregate-`ok` emit stranded it). The next turn on that scope re-composes COLD — the
manual `/reset` rehydrates the full grounding on the following turn instead of
leaving the warm session without its system prefix.

**Layer B — orchestrator context reset + rehydrate (SPEC WAVE 3.5).** The warm
orchestrator (`cc-agent-*`) REPL accumulates transcript across many turns. To keep
its live window small, a periodic policy (`gateway/wiring/context-reset-policy.ts`,
5-min tick, wired in the composer's realmode region) sweeps the owner's warm pool
(`createPooledContextResetSweep`, `runtime/adapters/claude-code/persistent/context-reset.ts`):
for each idle session whose POST-COMPACT transcript has grown ≥ 2 MB
(`DEFAULT_CONTEXT_RESET_THRESHOLD_BYTES`) SINCE its last reset, it actuates `/clear`
(the SAME mutex-safe `actuateSessionContextReset` the `/reset` command uses, never
mid-turn) and — SYNCHRONOUSLY, under that session's turn mutex, the instant `/clear`
lands and before the mutex releases — emits the scope on the context-reset bus. (The
un-mark rides the sweep's actuation, not a post-sweep loop, so a turn that acquires
the just-cleared session AFTER the reset lands re-composes cold.) One residual race
survives the mutex alone: a turn that read `isColdFirstTurn` (chose WARM) BEFORE the
sweep fired, but re-marks `contextSent` AFTER — its already-built warm prompt would
resurrect the warm mark on the just-emptied REPL. The runner closes it with a
per-scope RESET-EPOCH captured at the warm/cold decision and re-checked before the
re-mark: if a reset for the scope fired in between, the re-mark is SKIPPED so the
next turn still re-composes cold. The runner
(`build-live-agent-turn.ts`) subscribes via `contextResetSignal`: on a scope-S
signal it un-marks warm every topic in S (and bumps the scope's reset-epoch), so the next turn re-runs
`composeFirstTurnPrompt` — the lossless external-state rehydration (work board +
STATUS + docs + persona + reflection + memory index + nexus + services re-assembled
from durable state). The trigger is a per-session BASELINE DELTA (a `WeakMap` keyed
on the `ReplSession` object) so it fires only on growth since the last reset and can
never re-fire-loop, regardless of whether CC keeps appending the same JSONL after
`/clear` or rotates to a new file (a respawned session restarts at baseline 0). A
per-scope 45-min cooldown gates re-resets. The `session-size-watchdog` (5 MB warn /
10 MB critical) stays the wedge BACKSTOP; Layer B keeps the orchestrator in the good
zone. The CLI persistent-REPL context-editing beta (`clear_tool_uses` tool-result
eviction) is NOT available for the interactive `claude` PTY REPL substrate — no CLI
flag, no codebase primitive — so this composer-side periodic-reset-and-rehydrate is
the path SPEC WAVE 3.5 anticipated as the fallback.

**Two tool factories per Core.** The install pipeline
(`gateway/cores/install-bundled.ts → registerCoreTools`) resolves `buildTools`
from a Core's barrel and, if present, ALSO `buildExtraTools` — a second factory
returning additional handlers merged over the base set. Both receive the same
`deps` bundle. The split lets a Core keep its legacy tool surface
construction-compatible while shipping new tools separately (Research, Calendar,
and Tasks all use it). Any manifest-declared tool that NEITHER factory
returns a handler for registers as a loud `not_implemented` stub and logs
`manifest_tool_unimplemented` — the manifest never silently lies about its
surface.

### Per-project credential resolution (D2)

Every Core resolves its credential through ONE seam — the
`CoreCredentialResolver` (`gateway/cores/core-credential-resolver.ts`) — keyed by
`(active project, service)`, with the `project_credentials` store (PR #149) as
THE path and the per-instance `OAuthTokenManager` as the legacy global fallback.
There is no flag and no dual path: "global" is a scope *within* the resolver, not
a separate code route.

Resolution order per call: (1) `ProjectCredentialStore.resolve(owner_slug,
project_id, service)` — per-project → global; (2) `OAuthTokenManager
.getAccessToken(label)` for the three Google labels (transparent refresh) as the
instance-wide default; (3) `null` (uncredentialed → the Core's graceful empty
state).

**D2 per-credential granularity** (a `SERVICE_SCOPE` policy, not a flag):
- **Email + Calendar** (`gmail_compose` / `google_calendar`) stay **GLOBAL** —
  routed through the resolver for uniform plumbing, but the active project id is
  *ignored* (scope forced to the global sentinel), so a stray per-project row can
  never shadow the shared grant and there is **no per-project re-consent / no
  regression** to the working inbox/calendar.
- **A project's own Google Drive** (`google_workspace`) **+ any static service
  token** (Meta Ads, Google Ads, an Apify key, …) resolve **PER-PROJECT →
  global**: a project's pasted token wins; else the instance default.

**Per-project connected-account selection (ISSUES #500).** CONNECTING an account
stays global — one consent, one access token, one refresh token, one thing to
rotate — and only SELECTION is per-project. `accountsFor` (the primitive every
Core reads through; `resolve` narrows it, `accountsResolverFor` wraps it) filters
the connected set against `project_account_selection` (migration `0115`, STRICT)
before returning it, so a work project stops sweeping a personal mailbox without
disconnecting anything. Enforced at that ONE seam, so every Core inherits it and
none implements its own filter.

Rows are **DISABLES**, and that is the contract, not a storage detail: a project
with no rows reads every account (the pre-#500 behaviour, so shipping this
changes nothing until the owner narrows something), and a newly connected
account has an `account_id` no existing row can name, so it is visible in every
project including ones that already narrowed. An enable-list would need a second
"configured yet?" bit for the first and would hide the second until every project
was re-visited. Disabling the LAST account for a service is allowed — a project
that does not use Gmail is a legitimate configuration — and the surface says so
in words rather than rendering an unexplained blank.

Note the deliberate asymmetry with `SERVICE_SCOPE` above: the scope policy forces
the GLOBAL sentinel when choosing which credential STORE supplies the material,
but the selection filter uses the REAL active project id even for global-scope
services. Email and Calendar are exactly the services an owner connects several
accounts to, so forcing the sentinel there would make the feature a no-op for the
only services that need it. A blank project id (General topic, cron, system
dispatch) has no selection and filters nothing.

**Active-project plumbing.** The per-instance Core clients are built once at boot
with a `() => Promise<string|null>` accessor that carries no per-call project
argument, so the active project is bound as **ambient async context**
(`gateway/cores/active-project-context.ts`, an `AsyncLocalStorage`) at the
in-process chat-command boundary (`gateway/http/chat-bridge.ts` wraps
`chatCommandFilter.match(...)` in `runWithActiveProject(project_id, …)`). The
resolver reads it back when the accessor fires — the single in-process `await`
chain propagates the frame straight through. When no frame is bound (the General
topic, or the CC-spawn MCP-tool path, which crosses a process + loopback-HTTP
boundary the frame can't follow) the active project resolves to `''` → **global
scope**, i.e. the exact pre-D2 per-instance behavior (safe, no regression).

**Active-project scope over the CC-spawn MCP-tool path (work-board / trident-build
tools).** The credential-resolution slice above still resolves global on the MCP-tool
path, but the **work-board + trident-build tools now DO carry the active project**.
The warm conversational REPL is keyed per-project (`poolKeyFor` folds
`metering_context.project_id`), so a given session serves exactly one project
scope; the substrate stamps that scope onto the `ReplSession` and the topic-agnostic
`/tool-call` sink threads it into `McpServer.dispatch({… project_id})` →
`ToolCallContext.project_id`. The `work_board_*` tools and the trident build-dispatch
tools (`work_board_dispatch_build` / `work_board_start`) then resolve their storage
scope via `workBoardScopeKey(ctx.project_slug, ctx.project_id)` — so **a work item /
build created by the agent while chatting in project X lands on X's board and the
`code_trident_runs.project_slug` scope-keys to X, not the General bucket** (the P0
this fixes; before, the agent tools fell back to the instance slug = General). The
per-turn *injected* `<work_board>` block is scoped the same way (composer
`workBoardSnapshot` → `workBoardScopeKey`), so the board the agent re-grounds on
matches the board its writes land on. General (no active project) still scope-keys to
the owner slug, unchanged; the HTTP ▶/create surface already scope-keyed from the URL
`project_id`. Forwarding the topic itself (so `ToolCallContext.topic_id` populates for
`message_search`) remains the documented next slice.

> **General's Work view — CLOSED.** General is a genuine board bucket
> (`owner_slug`) and the HTTP surface serves it. General now has the SAME Work
> surface every named project has, scoped to its own (`owner_slug`) board: on
> desktop (≥1024px) the right-edge **Work** slide-out pane (`PlansPane`, with the
> edge-handle + auto-open/close), and below 1024px a seated **Work** tab. The web
> chat's tab-set builder (`landing/chat-react/ProjectShell.tsx`, the `if (isGeneral)`
> branch) injects the builtin `work_board` descriptor into General's tab set
> (`GENERAL_WORK_TAB`, mirroring the mobile shell's `ensureWorkTab`), so the
> existing `showPane` gate + narrow-tab path light up for General with no branch.
> The client scopes General as `projectId === ''` everywhere (so the live
> `work_board_changed` filter — `(framePid ?? '') === projectId` — applies General's
> no-`project_id` snapshot); the work-board HTTP client maps that empty id to the
> literal `'general'` path segment (`workBoardPathSegment`) because the surface
> keys General on `'general'` (→ `owner_slug`) and 400s on an empty segment. No
> scope-key semantics changed (`work-board/store.ts` untouched). NOTE: mobile
> General is not yet a navigable scope (its rail has no synthetic General entry,
> unlike web), so there is no mobile Work-tab-for-General gap to close here — the
> existing `ensureWorkTab` + badge machinery already applies to the `'general'` id
> the moment General becomes navigable on mobile.

> **M1 redesign polish (Ryan 2026-07-03) — CLOSED.** Four chat-UI refinements,
> no feature flags, one code path each:
> - **Favicon = the ⚛ atom mark.** `landing/favicon.svg` reproduces the `AtomMark`
>   geometry from `ChatApp.tsx` (center dot + 3 rotated orbit ellipses) in a FIXED
>   accent hex (a favicon can't read page CSS vars), so the browser tab matches the
>   rail-header icon.
>   **SUPERSEDED 2026-07-18** — as first shipped this mark was transparent and
>   stroke-only in `#007aff` at `stroke-width 1.6` on a `0 0 24 24` viewBox, which
>   at a 16px tab slot is a ~1.07-device-px mid-blue hairline on Chrome's near-black
>   tab strip: served correctly, rendered invisibly, reported as "no favicon". The
>   mark now carries an opaque `#0b0e14` tile, accent `#4da3ff`, and `0 0 32 32` @
>   `stroke-width 2.6`. A raster `landing/favicon.ico` (generated from the same
>   geometry by `scripts/gen-favicon-ico.py`) is declared first as the universal
>   fallback. See AS_BUILT §2026-07-18 "Favicon".
> - **Work-item delete confirm is INLINE-in-row, not a modal.** The old
>   full-screen `.cwb-confirm-backdrop` / `aria-modal` dialog was deleted; the ✕
>   now reveals a `.cwb-confirm-inline` `role="group"` strip WITHIN the item's own
>   row (`InlineConfirm` in `WorkBoardTab.tsx`) — Cancel + a destructive Remove,
>   Escape cancels, focus returns to the ✕. The confirm STATE machine
>   (`confirmDelete`, `requestRemove`, the #174 linked-run cancel) is unchanged;
>   only the render moved modal → in-row.
> - **The Work pane lives INSIDE the Chat view, with the composer as a full-width
>   footer.** The desktop slide-out (`PlansPane`) moved OUT of the `ProjectShell`
>   shell level and INTO `ChatApp`/`ChatSurface` (`.car-chatstage` = a row of the
>   message column + the pane, above a full-width `.car-composer` footer). So the
>   chat input bar spans the whole content width with the pane LIFTED above it,
>   and the pane is scoped to the Chat tab — it no longer bleeds onto Documents /
>   Settings (it's hidden with the Chat tabpanel; state survives a round-trip).
>   The shell still owns the `showPane` gate; the `.car-stage` grid was retired for
>   a plain flex box and `.car-plans-col` animates its own width (chat shrinks).
> - **Work rows are 2-line (title / tag+round), collapsing to 1-line when queued.**
>   `WorkBoardRow` (web `WorkBoardTab.tsx` + mobile `app/components/WorkBoardRow.tsx`)
>   stacks a `.cwb-row-line1` (dot + full title + hover actions) over a muted
>   `.cwb-row-meta` (phase tag + `round N`), gated on `hasStatus` (`tag !== null`)
>   so a bare queued card is a single title line and a done row carries "Merged ·
>   <date>" on line 2. Titles no longer truncate prematurely.

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

### Scraping Core (`cores/free/scraping/`, `@neutronai/scraping-core`)

Tier 1 free Core for Instagram + X/Twitter scraping via Apify (the legacy harness parity
gap #6 — a direct port of `~/legacy/scripts/ig-scrape.sh` + `tx-scrape.sh`).
WebFetch/oEmbed can't see this content (Meta gates IG; X serves only the React
shell), so the Core calls the Apify `run-sync-get-dataset-items` endpoint
against three no-approval actors: `apify/instagram-scraper`,
`kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest` (tweets /
threads / profiles), and `fastcrawler/x-twitter-article-to-markdown` (X long-form
Articles).

**Optional-until-credentialed (the load-bearing invariant).** The Core declares
a single `byo_api_key` secret (label `apify`, `required: false`) in its manifest.
That slot auto-surfaces in the admin Integrations surface (`/api/cores/api-keys/apify`)
AND the agent-native `integrations_list` / `integrations_connect` chat tools —
both read the bundled-Cores registry dynamically, so no gateway wiring is needed
for the slot to appear. The backend resolves the token PER CALL via the
capability-gated `SecretsAccessor` (`accessor.get('byo_api_key', 'apify')`), so a
token pasted after boot takes effect with no restart. **With no token stored the
capability no-ops** — it returns `{ok:false, code:'no_token'}` with guidance to
add the token in admin and **never calls Apify**. The Core still installs cleanly
(the secret is optional), it just stays inert until credentialed.

Two MCP tools (capability-guarded + audited under `network:browse`):
`scrape_instagram` (modes `json`·`caption`·`summary`) and `scrape_x` (modes
`json`·`text`·`summary`·`article`, plus `thread` for author-filtered
conversations). The same backend is DESIGNED to power the `/scrape <url> [mode]
[--thread]` chat command (`createScrapingChatCommandFilter`), which auto-detects
IG vs X from the pasted URL — but **that half is not wired today**: nothing calls
`buildProductionScrapingCoreWiring`, so `/scrape` reaches no composed chain and
falls through to the model. The capability is reachable by the AGENT and not by
the owner, so the agent-native parity is broken in one direction. Found by the
widened reachability scan 2026-08-02 and pinned by a live probe in
`open/__tests__/reachability-inventory.ts` (`CHAT_COMMANDS_KNOWN_UNREACHABLE`) —
see § Reachability gate. The production wiring helper
`buildProductionScrapingCoreWiring(secretsAccessor)` builds the one shared
backend both surfaces use; the MCP path is wired self-sufficiently in
`buildCoresBackendFactories` (`scraping_core` factory reads
`installation.secrets_accessor`), so the tools work the moment Cores compose —
no composer-threaded backend required (unlike `research_core`).

### Cores→scribe phase-2 fan-out (`gateway/cores/mount-cores-scribe-fan-out.ts`)

The scheduled Calendar + Email Cores feed scribe's extract→GBrain path as
**ambient extraction sources on top of the Cores** (no new pollers): the
pre-meeting-brief + daily-triage scheduler `fire` callbacks hand their
already-fetched event/inbox rows to a `scribeFanOut` hook
(`gateway/cores/{calendar,email-managed}-wiring.ts`), which the composer binds to
`scribe.extractFromCoresSource(...)`. This complements the chat-turn extractor
(`scribeOnUserTurn` → `scribe.handleUserTurn`): chat captures what the owner
*says*; the fan-out captures what their *calendar and inbox* contain.

> **Chat-turn extractor wiring (2026-06-28 fix).** `scribeOnUserTurn` must be
> fired by EVERY chat surface, or chat-time memory is silently dead. It is wired
> in the legacy web `chat-bridge.handleInbound` AND — as of the fullpipe-e2e fix —
> in the unified `/ws/app/chat` receiver (`open/composer.ts` `appWsReceiver.receive`,
> after `appWsChatTurn`). The React client uses `/ws/app/chat` exclusively, so
> before the fix NO post-onboarding chat turn extracted facts to GBrain (the store
> stayed empty; "recall" only worked from in-session CC context). Note this is a
> DISTINCT layer from the onboarding seam's `onTurnComplete` (which extracts the 5
> onboarding PROFILE fields, not general people/companies/concepts). Fire-and-forget
> + guarded, omitted on LLM-less boxes. Regression guard:
> `open/__tests__/open-app-ws-scribe-wiring.test.ts`.

**Wired into the Open boot path** (`open/composer.ts`, gated on scribe being
live) via `mountCoresScribeFanOut(...)`, which builds the binding and returns a
**late-bound handle**. `wireMemory` CONSTRUCTS it (nothing started) and registers
its drain+teardown `stop()` against `realmode_cleanups` early; the composer ARMS
it — `coresScribeFanOut.arm({ calendarClient, gmailClient })` — LAST, after
`mountOpenCores` has built the live Google clients, which is where the two
schedulers are actually composed from those factories and started. The binding is
fire-and-forget (a failed extraction never throws into a Core's brief/triage path)
and exposes `idle()` for clean shutdown draining. Each scheduler owns its own
self-tick — **no duplicate poller, no extra timer/fetch** beyond the Cores'
cadence.

> **M2-1 (2026-07-20) — the fan-out now receives the LIVE Google clients.**
> `mountOpenCores` exposes `calendarClient` + `gmailClient` on `MountedOpenCores`
> — the SAME instances the `calendar_core`/`email_managed_core` MCP tools + the
> `/cal` / `/email` filters use (OAuth-backed when Google is connected, in-memory
> fallback otherwise) — and the composer arms the fan-out with them. Before M2-1
> the fan-out was constructed inside `wireMemory` with NO clients, so it fell back
> to fresh in-memory stand-ins and fanned out **nothing even when Google was
> connected** — the exact "wired but does nothing" partial-port. The
> **late-binding** shape (construct-early / cleanup-early / arm-after-
> `mountOpenCores`) mirrors the `reflectLoop` precedent, because the clients are
> built ~100 lines AFTER `wireMemory` runs. `arm()` is failure-atomic and
> `stop()` is a safe no-op before `arm`, so a composition failure between
> construction and the arm leaks no scheduler. With OAuth absent the clients are
> the in-memory fallbacks and the schedulers fan out nothing (unchanged, correct);
> with Google connected, real events/mail now flow into GBrain with no further
> wiring. Regression guards: `gateway/cores/__tests__/mount-cores-scribe-fan-out.test.ts`
> (live-client arm reaches the writer; unarmed/in-memory fan nothing; arm-twice
> guard) + `gateway/cores/__tests__/mount-open-cores.test.ts` (clients exposed).

Always-on when scribe is — **no feature flag**. (The Cores' MCP tools + `/cal` /
`/email` chat surfaces are now composed into Open too — see the next section.)

## Free Cores in the Open boot path (parity gap #2) — `gateway/cores/mount-open-cores.ts`

The single-owner Open composer composes the bundled free Cores
(Calendar / Email / Google-Workspace / Reminders / Research) into the
daily-driver, **reusing the Managed mechanism — not a fork**:

- **Backends + MCP tools.** `open/composer.ts` sets `composition.cores` (dataDir +
  per-instance `SecretsStore` + the `buildCoresBackendFactories(...)` map +
  a `SecretsStorePrompter`). Because `boot()` runs every composition through
  `composeProductionGraph`, that flips on the cores module
  (`gateway/composition/build-core-modules.ts`) → `installBundledCores` discovers
  the bundled Cores (rootDirs from the platform adapter) and registers each Core's
  `buildTools(deps)` MCP surface. Per-Core install is **fail-soft**
  (`install-bundled.ts`) so a Core lacking creds is hidden without blocking boot.
- **Chat-command filters.** `mountOpenCores` chains the bundled free-Core filters
  (`/cal`, `/email`, `/remind`, `/research`) via
  `buildChainedChatCommandFilter([...])` and the composer threads the result into
  `createAppWsSurface` (`gateway/http/app-ws-surface.ts`) as `chat_command_filter`.
  The app-ws surface invokes the filter at the top of the `user_message` /
  `button_choice` path (`app-ws-surface.ts:605` / `:783`) and, when a Core claims
  the command, ships the Core's reply as an `agent_message` and short-circuits the
  live-agent turn (`appWsChatTurn` / `build-live-agent-turn.ts`). (K11b0 excised
  the dead `/ws/chat` `buildWebChatBridge` that once also carried this filter;
  `/ws/app/chat` is now the sole owner chat transport.) Before this the Open chat
  had no slash-command interception at all; a typed `/cal` fell through to the LLM.
  Each Core's MCP tools and its chat-command filter share **one backend instance**
  (the pre-built `calendarClient` seam, one `EmailProjectCacheResolver`, the
  Research `project_backend`) — agent-native parity.
- **Optional-until-credentialed.** A per-instance `OAuthTokenManager` over the
  `SecretsStore`. With no `NEUTRON_CORES_GOOGLE_CLIENT_ID` (the zero-creds Open
  default) the Calendar/Gmail/Workspace backends fall back to in-memory clients —
  `/cal` / `/email` answer against an empty calendar/inbox, never a hard error,
  never a boot block; the Google Cores' MCP install is hidden (their `required`
  `oauth_token` secret is unprovisioned) until a grant exists. The moment the
  `SecretsStore` holds the token the `SecretsStorePrompter` surfaces it and those
  Cores install **live** — no restart, no further wiring. **No feature flag.**
  (The in-product OAuth-connect admin surface — Open's cookie-auth ↔ the Cores
  surfaces' bearer-token contract — is a documented follow-up; the token-present
  install path is already wired and tested.)

### The Google grant flow and its BROKER — `gateway/http/cores-oauth-{surface,broker-surface}.ts`

Google only redirects to a redirect_uri pre-registered on the OAuth client, so
whatever sits behind that one URI has to work out which instance a given callback
belongs to. `state` is the handle and the **broker** is the lookup. The instance
surface (`/api/cores/oauth/google/{start,ingest,disconnect/<label>,status}`) mints
a 192-bit random `state` plus a PKCE verifier it keeps **locally**, POSTs a
routing row (`state → project_slug + dispatch_url`) to the broker's
`/oauth/cores/pending/register`, and sends the owner to Google. Google redirects
to the broker's `/oauth/cores/google/callback`, which consumes the row
(single-use, short-lived) and relays `{code, state}` to that row's `dispatch_url`
— the instance's own `/ingest`, which holds the verifier and the client secret and
performs the exchange. **The broker never holds an OAuth secret**; it holds
routing metadata. Both the register call and the relay are HMAC-signed
(`runtime/internal-signature.ts`, ±5 min window).

**On success the callback RETURNS the owner** (ISSUES #495): a `303` to
`<instance-origin>/chat?tab=admin`, the connected-accounts view. The origin is
taken from the consumed row's `dispatch_url` (the instance's own base URL), so
one central broker sends each owner to their own instance with no extra config.
The target is `origin` + a constant — `code`/`state` are not in scope where it is
built and `.origin` discards any query or fragment — and the response sets
`referrer-policy: no-referrer` so the callback's own URL cannot leak the grant as
a `Referer`. `?tab=admin` is read at boot by `initialTabKeyFromLocation`
(`landing/chat-react/config.ts`) and applied by `ProjectShell` once the scope's
tab set resolves; it carries no `?project=` because Admin is global-scope and
renders only in General. **Failures do not redirect** — every error arm keeps a
terminal page naming the reason, since a silent bounce back to Settings after a
grant that never completed is indistinguishable from success.

`register` is **insert-only / same-owner**: on `ON CONFLICT(state)` it updates
only while the stored `project_slug` equals the incoming one, so a signature
holder who learned somebody else's `state` can create a registration but never
take one over; a mismatch is a no-op answering 409 `state_owner_mismatch`. Retry
idempotency is unaffected — the same state for the same slug still refreshes its
dispatch_url and expiry (SPEC § Decisions Log 2026-08-04).

**Where the broker runs is CONFIGURATION, one implementation either way**
(`open/cores-broker-binding.ts`, resolved in `open/composer.ts` right after the
declared-origin guard):

- **Nothing declared → CO-LOCATED.** The instance is its own broker.
  `identityBaseUrl` / `ownerBaseUrl` / `redirectUri` are all its own
  `NEUTRON_CONNECT_PUBLIC_BASE_URL` origin, the HMAC secret is derived from the
  instance's existing AES keyfile (`deriveColocatedBrokerSecret` — no new secret
  to generate, store, back up or leak), and `cores_oauth_broker_surface` **is**
  mounted. This is every self-host.
- **`NEUTRON_CORES_OAUTH_BROKER_BASE_URL` + `NEUTRON_CORES_OAUTH_BROKER_SECRET`
  → CENTRAL.** `identityBaseUrl` and `redirectUri` point at that origin, the
  secret is the supplied deployment-wide one, and the local broker surface is
  **not** mounted (the "instances leave this unset" case
  `gateway/composition/input/cores-input.ts` describes). **`ownerBaseUrl` stays
  the instance's own origin** — it becomes the `dispatch_url` the broker relays
  back to, so pointing it at the broker makes the callback undeliverable.
- **Half a declaration is refused**, not silently downgraded: the boot log carries
  `cores_oauth_broker_misconfigured` naming the missing env and the OAuth surface
  stays unarmed, the same trade as the undeclared-origin guard above it. The
  secret is never logged.

Both configurations are pinned against the real composer output in
`tests/integration/cores-oauth-remote-broker.open.test.ts`; the origin guard is
`tests/integration/cores-oauth-base-url-guard.open.test.ts`.

### One grant per ACCOUNT — the identity scope that makes it work (ISSUES #494)

A grant is stored under `<service>#<account_key>`, so an owner who runs several
Google accounts gets one independent grant per account instead of one that
clobbers the last. `account_key` is a truncated SHA-256 of the account address
(`accountKeyFromEmail`), and the address comes from ONE place: a userinfo call
`OAuthTokenManager.exchangeAndPersist` makes right after the code exchange.

That means **the authorize URL must ask for identity, or the whole scheme is
inert.** It didn't, until #494. `runOAuthStart` built the `scope` param as the
union of the Cores' manifest-declared scopes, and no manifest declares an
identity scope (nor should one — identity is a property of the grant store, not
of any Core's API surface). With no identity scope userinfo cannot answer, every
grant is anonymous, every grant for a service lands on the bare `<service>`
label, and connecting a second account silently REPLACES the first.

The fix seeds the scope set with `GOOGLE_IDENTITY_SCOPES`
(`gateway/http/cores-oauth-surface.ts`) on every grant this gateway starts:

- **`openid`** — `GOOGLE_USERINFO_URL` is `.../oauth2/v3/userinfo`, the alias of
  the `userinfo_endpoint` Google publishes in its OpenID discovery document
  (`https://openidconnect.googleapis.com/v1/userinfo`). That is the OIDC
  UserInfo endpoint, which serves only tokens issued with `openid`.
- **`https://www.googleapis.com/auth/userinfo.email`** — `openid` alone returns
  just the `sub` claim; the `email` claim needs the email scope. `profile` is
  deliberately NOT requested: the address is the whole requirement.

`prompt` is also now `select_account consent`. `consent` still forces a
refresh_token on repeat grants; `select_account` is what makes a second account
reachable at all — with `consent` alone and a single signed-in Google session,
Google resolves the consent against that session, so "add another account" would
silently re-grant the one already connected.

**Migration of an existing anonymous grant.** Nothing is rewritten at boot; the
grant an install already holds keeps working untouched, because `listGrants`
adopts an un-keyed row as an account with `account_key: null` and every read path
(`CoreCredentialResolver.accountsFor`, `getServiceAccessToken`, `handleStatus`,
`buildIntegrationsStatus`, and install's `resolveServiceGrantLabel`) resolves
through it. The row converts on the next consent, via `retireLegacyRowFor`:

- a bare row naming the SAME address is retired (it is now the keyed grant);
- a bare row naming a DIFFERENT address is a real second account and is left
  completely alone — it migrates when THAT address is next granted;
- a bare row naming NO address — the #494 population — is retired
  unconditionally. Its access token was minted without `openid`, so re-querying
  userinfo with it returns nothing and no future exchange can ever match it: it
  can never migrate, and leaving it would have `listGrants` adopt it forever
  ALONGSIDE the keyed grant, reading the same mailbox twice.

End-to-end coverage — real `/start` → the real authorize URL → a fake Google that
honours the scope it was asked for (401 from userinfo for a token issued without
`openid`, exactly as the OIDC endpoint does) → real `/ingest` — is
`gateway/__tests__/cores-oauth-identity-scope.test.ts`. The fake spells out
Google's rule literally rather than importing `GOOGLE_IDENTITY_SCOPES`, so
emptying the constant reds the test instead of passing vacuously.

## Native-MCP tool transport (P0-1) — how the spawned agent invokes tools

The live chat agent is a spawned interactive `claude` REPL driven over the
dev-channel (`runtime/adapters/claude-code/persistent/`). It reaches the
gateway's in-process tool surface — Cores (`/cal` `/email` `/remind`
`/research`), `doc_search` / `doc_read`, `message_search`, `memory_search`
(memory recall, P0-2), `dispatch_agent`, `skill_forge_*`, and the
`neutron-tools` surface — as **native MCP tool calls**, not via the user typing
a slash-command.

- **The transport.** At spawn the substrate writes a per-session `--mcp-config`
  with TWO `mcpServers`: the dev-channel (the reply sink) **and** a `neutron`
  tools-bridge (`tools-bridge.ts`). The bridge is a stdio MCP server that
  advertises the registry's tools (from a manifest the substrate snapshots at
  spawn time) and forwards each `CallTool` to the substrate's reply-sink HTTP
  server (`POST /tool-call`), which dispatches against the in-process
  `McpServer`. Tools surface to the model as `mcp__neutron__<toolname>` with
  their real `input_schema`, so the agent emits a structured `tool_use`
  mid-reasoning and gets a structured `tool_result` it can chain on. The
  in-process registry's stdio transport (`mcp/server.ts`, once "deferred to P1
  S5+") IS this bridge.
- **Late binding.** The substrate is built in the composer before
  `composeProductionGraph` builds the `McpServer` + registers all Cores, so the
  bridge dispatcher is wired late: the `repl-tool-bridge` module (deps `['mcp']`)
  calls `setReplToolBridge(graph.get('mcp'))` once the registry is populated;
  shutdown clears it. LLM-less boxes (no graph) leave it unset → no second
  server.
- **Security (opt-in per substrate).** Only the owner's WARM conversational
  substrate (`cc-agent-*`) sets `enableToolBridge: true`. The untrusted
  history-import REPL (`cc-import-*`), the per-project onboarding-compose REPL
  (`cc-compose-*` — see "Per-project isolated onboarding compose" below), and the
  Trident build / fire REPLs (`cc-trident-*` / `cc-trident-fire-*`) leave it off,
  so a prompt-injection in untrusted content can never reach a Core tool. The bridge's MCP namespace is
  permitted via `--allowedTools mcp__neutron`. The built-in `--tools` surface is
  per-turn (`AgentSpec.tools`): the untrusted import REPL keeps `--tools ""`
  default-deny (no Bash/Read/Skill); the live agent declares
  `Read,Glob,Grep,Write,Edit,Bash,Skill,Workflow` (Work Board Phase 2a adds
  `Workflow` so the orchestrator can fire background tridents + stay responsive —
  a constant-surface addition that satisfies the warm-REPL reuse guard). The
  Trident v2 FIRE turn is a TRUSTED build path and declares EXACTLY `Workflow`
  (`WORKFLOW_FIRE_TOOL_NAMES`) — it only fires the inner CC Dynamic Workflow +
  settles; the Forge/Argus/Bash work runs inside the workflow's own nested agents.
  These per-turn surfaces never relax the import REPL, and the MCP tool bridge
  stays OFF on the trident substrates.
- **Substrate security config is PROFILE-based** (tool-security redesign Step 0,
  2026-07-20). The security knobs of a `buildLlmCallSubstrate` spawn
  (`skip_permissions` today; reserved shape for `permission_mode` /
  `claude_config_dir` / `extra_env` / `sandbox`) live in named
  `SubstrateProfile` constants in `gateway/wiring/substrate-profiles.ts`
  (`PROFILE_WARM_CHAT`, `PROFILE_UNTRUSTED_IMPORT`, `PROFILE_PHASE_SPEC`,
  `PROFILE_TOOLLESS_UTILITY`, `PROFILE_EPHEMERAL`, `PROFILE_WARM_FIRE`), not in
  per-site inline literals. All six encode today's value byte-for-byte
  (`skip_permissions: true`); the split into distinct constants is what lets the
  coming permission migration diverge per caller-trust-class as N constant edits.

### Native SKILL.md discovery for the agent (P1-5)

The live agent discovers + invokes Claude Code **skills** natively — the same
built-in mechanism the legacy harness's `~/.claude/skills` rides on. At composer build,
`provisionAgentSkills()` (`runtime/adapters/claude-code/persistent/agent-skills.ts`)
materializes the bundled `SKILL.md` packs from the repo-root `skills/` dir
(`impeccable` + design sub-skills, `agent-browser`, `remind`) into the live
agent's **project** skills dir (`<owner_home>/.claude/skills/`, which the spawned
REPL — cwd = `owner_home` — discovers natively). The `Skill` built-in tool is in
the live agent's `--tools` allow-list, so the agent loads + invokes a pack
mid-turn. Project-scope (not a custom `CLAUDE_CONFIG_DIR`) is deliberate: the
default config dir holds the REPL's credentials, so a custom config dir would
break auth. Skill-forge's approved-skill **output** writes native packs into this
same dir (`registrar.ts` → `<skillsDir>/<name>/SKILL.md`), so a forged skill is
immediately discoverable + invokable too. Provisioning is idempotent and never
deletes a forged pack.
- **The command-filter's role.** `buildChainedChatCommandFilter`
  (`open/composer.ts`) is the **user's** slash-command path: it intercepts a
  user-typed `/cal` `/remind` etc. BEFORE the LLM and routes to the SAME
  registry tool backend. It is NOT an agent-invocation path — the bridge is the
  agent's single native path. One underlying tool implementation, two entry
  surfaces (user-typed slash vs. agent-native MCP).
- **The chain's members** (`open/composer.ts`, in order): the Free-Cores filter,
  skill-forge (`/skills`), `/status`, `/reset`, and the Trident `/code` entry
  (`buildTridentCodeChatCommandFilter`). `/code` was BUILT-BUT-NOT-WIRED until
  2026-08-01 — the filter and the whole durable Trident stack behind it (run
  store, tick loop, delivery, terminal observers) were composed, but the filter
  was never added to this chain, so its only non-test references were barrel
  re-exports and every `/code …` fell through to the LLM as ordinary chat. Its
  context resolves PER MESSAGE, reaching the canonical `workBoardStore` through
  the same late-bound holder agent-dispatch uses, and scoping the build to the
  message's board (`workBoardScopeKey`). On an LLM-less boot it resolves `null`,
  so `/code` is still CLAIMED and answered "unavailable" rather than writing a
  run no tick loop could ever advance. Wiring is pinned end-to-end over a live
  socket by `open/__tests__/open-code-command-wiring.test.ts`.

## Mobile app boot + server URL (ISSUES #385) — `app/lib/server-url.ts`, `app/lib/config.ts`

The Expo app is a client of the owner's OWN instance (a box on their LAN, a
self-hosted domain, or a managed subdomain), so **the address is resolved at
runtime and persisted on the device** — one build works for any self-hoster,
and no build ever carries a baked instance URL. There is NO loopback default:
`app/lib/config.ts` previously substituted `http://127.0.0.1:8080` when nothing
was configured, which on a phone IS the phone, so every request failed
silently.

**The app LEARNS its address; typing one is the self-host path.** See
§ "Login-first instance discovery" below — the app opens on `/login`, signs in
at central identity, and reads its own `publicUrl` from `POST
{auth_base}/v1/route`. The typed-URL form described in this section still
exists and still owns the normalise → validate → persist rules (discovery
routes through the very same `commitServerConfig`), but it is no longer the
first-run surface.

- **Resolution (`app/lib/server-url.ts:resolveServerBases`, pure/unit-tested).**
  Per field, precedence is **persisted runtime value > `Constants.expoConfig.extra.neutron_*`
  > `process.env.EXPO_PUBLIC_NEUTRON_*` > unconfigured** — the owner's in-app
  choice beats a baked-in build default, so a build pointing at the wrong host
  is recoverable on the device. Every source is normalised
  (`normalizeServerUrl`: adds `https://` when schemeless, lower-cases
  scheme+authority, drops query/fragment, strips trailing slashes, validates
  the authority + port range) and `configured` is derived from the NORMALISED
  result, so a degenerate source can never report a configured install.
  Unconfigured ⇒ `''` + `configured: false`, never a fabricated URL.
  The env tier MUST be read as a literal `process.env.EXPO_PUBLIC_*` member
  expression — `babel-preset-expo` only inlines that exact form, so aliasing
  it silently kills build-time configuration in every real build.
- **Sync-read contract (`app/lib/config.ts`).** `loadAppConfig()` is called
  from ~20 call sites, mostly inside `useMemo`, so it stays SYNCHRONOUS: the
  persisted value is read once at boot by `hydrateServerConfig()` into a
  module-level cache, and `setRuntimeServerConfig()` updates that cache after
  an in-app change.
- **Boot phase machine (`app/app/_layout.tsx`).** `'hydrating'` (spinner) →
  `await hydrateServerConfig()` → `'ready'` (the app tree). Hydration must be
  awaited before anything mounts because `loadAppConfig()` is synchronous.
  There is no third `'setup'` phase any more: login-first deleted the
  unconfigured branch that rendered `ServerSetupGate` INSTEAD of the `<Stack>`,
  so the Stack always mounts and `/login` is the landing surface. The #385
  invariant it enforced — never issue a request against an unconfigured
  install — moved to two places: `app/app/index.tsx` refuses to leave `/login`
  while `configured === false`, and deep-link + push-tap routing are gated on
  `phase === 'ready' && loadAppConfig().configured` (pinned by
  `app/__tests__/push-deep-link-routing.test.ts`).
- **One commit path (`commitServerConfig`), THREE entry points.** Login-first
  **discovery** (`app/lib/identity-client.ts:adoptDiscoveredInstance`), the
  Settings editor (`app/app/settings.tsx` "Neutron server" card, reached from
  the projects header's **Settings** button) and the self-host card on
  `/login` all share it: normalise → validate → persist → wipe a mismatched
  session. A DISCOVERED address is therefore health-checked by exactly the
  same rules as a typed one — one implementation, three callers, no second set
  of rules (`app/__tests__/server-editor-reachability.test.ts` pins the caller
  list exhaustively). All three are required for the feature to be
  recoverable: `/settings` bounces to `/login` whenever auth resolves to
  unauthenticated (`app/lib/auth-helpers.ts:shouldRedirectToLogin`), so an
  install with a stale host and no token would otherwise be stranded with no
  way to fix the address. That test also enumerates every
  `router.push`/`replace` literal in `app/` and fails if `/settings` stops
  being navigable. The
  validation is `GET /healthz` on the entered origin, and the body must parse
  as the gateway's health JSON (`{ status, project_slug, … }`,
  `gateway/index.ts:786-789`) — a 200 alone would let a captive portal or
  router page validate as "your gateway". A `status: 'degraded'` gateway still
  passes (`/healthz` answers 200 when degraded by design). Persist happens
  BEFORE the session wipe, and the wipe fires whenever the committed host
  differs from the previously resolved one — including on the first-run gate,
  where an OTA'd install can be holding a token minted against the old
  loopback default. If the wipe rejects (partial AsyncStorage IO failure) the
  persisted config is rolled back, so a failed change is a clean retryable
  no-op rather than "storage on the new host, process on the old one". The
  session wipe is also why login-first adopts the discovered host BEFORE
  persisting the new session token — see the ordering note in the next
  section.
- **Invalidating already-mounted screens.** `setRuntimeServerConfig` bumps a
  module-level **epoch** (`getServerConfigEpoch`) and notifies subscribers.
  `app/app/_layout.tsx` uses that epoch as the app tree's React `key`, so a
  server change tears down and rebuilds every screen. This is load-bearing:
  ~10 screens freeze `loadAppConfig()` for their whole lifetime in
  `useMemo(() => loadAppConfig(), [])`, so mutating the cache alone would
  leave an open chat issuing HTTP + WS at the OLD host.
- **Warning, not a block, on plaintext to a public host.**
  `describeInsecureOrigin` flags `http://` to any authority that is not
  loopback / RFC-1918 / link-local / `.local` / IPv6-ULA. Android's blanket
  `usesCleartextTraffic` (unavoidable — the host is user-supplied at runtime,
  so no domain-scoped `networkSecurityConfig` can be authored at build time)
  would otherwise let the session bearer leave in the clear unremarked, while
  iOS blocks the same request.
- **OTA eligibility is deliberately withheld for this change.**
  `app/app.json` sets `updates.url` with `runtimeVersion.policy: "appVersion"`,
  so JS-only changes normally reach installed builds. The boot gate depends on
  the native cleartext permissions below, which `expo prebuild` applies at
  BUILD time — an OTA'd install would render a gate whose LAN probe the
  platform blocks and never get past it. Bumping `app.json` `version`
  (0.0.1 → 0.1.0) changes the derived runtimeVersion so older installs are not
  eligible; ship a native build for the new version instead.
- **Storage (`app/lib/token-storage.ts:43-44`).** Two new keys beside the
  session pair: `neutron.server.gateway_base_url` +
  `neutron.server.auth_base_url`. They are deliberately OUTSIDE `clearAll()`
  — signing out must not make the install forget which server it belongs to.
- **Native cleartext.** `app/app.json` carries `expo-build-properties` with
  `android.usesCleartextTraffic: true` and
  `ios.infoPlist.NSAppTransportSecurity.NSAllowsLocalNetworking` (+
  `NSLocalNetworkUsageDescription`) so the `http://<lan-ip>:7800` path this
  feature exists to enable is permitted on device. `NSAllowsArbitraryLoads` is
  NOT set: plain-`http` to a PUBLIC host stays blocked on iOS.
- **Build-time defaults** are optional server-side EAS environment variables
  selected by each profile's `"environment"` in `app/eas.json` — never
  literals in the repo. See `app/README.md` § "Build-time server URL".

## OTA updates vs real builds — the runtime-version boundary (`app/app.json`)

An `expo-updates` bundle may only be handed to an installed app whose **native**
side can actually run it. `runtimeVersion` is the token that encodes that
compatibility, and its POLICY decides whether the encoding is honest.

This project uses **`{"policy": "fingerprint"}`**. Expo hashes the native
project — installed native modules, config plugins, native config — so any
change to the native side yields a different runtime version automatically, and
an older build simply stops being offered bundles it could not execute.

It previously used `{"policy": "appVersion"}`, which derives the runtime version
from `expo.version` alone. That is a **silent footgun**: adding a native module
does not change the app version, so the new JS bundle keeps the OLD runtime
version and `expo-updates` judges it compatible with builds that do not contain
the module. The update ships, the import resolves to nothing, and the failure
lands on the owner's device rather than in CI. It was caught the day
`expo-audio` was added for voice messages — under `appVersion` that bundle would
have been delivered straight to an installed build with no audio native code.

Operational consequence, and it is the whole point of the change: **you can no
longer decide "OTA or real build?" from memory.** A JS-only change fingerprints
identically and goes out over the air; anything touching the native side
fingerprints differently and requires a real build plus a fresh install. The
tooling now enforces the distinction instead of relying on someone remembering
it.

Note that switching policies is itself a runtime-version change, so every build
produced under the old policy stops receiving updates and must be replaced once.

## App remote diagnostics — `app/lib/diagnostic-*.ts` + `gateway/http/app-diagnostics-surface.ts`

When the mobile app misbehaves on the owner's phone, the error and its recent
context land on **their own gateway**, where an operator reads them on the host.
No USB cable, no third-party service, no account. Neutron Open is self-hosted,
so a diagnostics pipeline that required a SaaS would not be the same product.
Always on — no feature flag, no env gate, one code path.

**What is covered:** JavaScript errors — an uncaught exception, an unhandled
promise rejection, and a React render crash.
**What is NOT covered:** **native crashes**. If the process dies before the JS
bundle runs (e.g. an Android provider failing during process start), no JS
executes to catch anything and there is no report. Those still need `adb
logcat` or an emulator. This closes the JS blind spot only.

- **Ring buffer (`app/lib/diagnostic-buffer.ts`).** A capped window of the last
  100 events — errors plus notable lifecycle markers — so a crash arrives with
  the context that makes it diagnosable. Bounded by construction; oldest
  evicted; no growth path.
- **Capture (`app/lib/diagnostic-capture.ts`).** Hooks `ErrorUtils`'s global
  handler (always **chaining** to the previous one, so RN's development redbox
  still fires), plus `unhandledrejection` / `error` listeners where the host
  exposes them. Host globals are injected, so the real installer is unit-tested
  without React Native. `app/components/DiagnosticsErrorBoundary.tsx` covers the
  render path, turning a blank screen into a report plus a retry.
- **Redaction — the load-bearing invariant (`app/lib/diagnostic-redact.ts`).**
  No credential ever enters a report. Two mechanisms: an EXACT-value scrub of
  credentials the process holds (the live bearer), and pattern rules for ones it
  does not — secret KEY names redacted whatever the value looks like, `bearer`
  prefixes, JWTs (whole or just the `eyJ…` header), `dev:<id>` tokens,
  `key=value` shapes in free text, and a 40-char opaque-run backstop. Depth,
  breadth and length are all bounded. `buildClientReport`
  (`app/lib/diagnostic-report.ts`) is the single choke point every report passes
  through and re-scrubs there, so one test covers all three creation paths.
  A report carries build metadata and `session.signed_in` — never the bearer,
  headers, server configuration, or a claimed identity.
- **Persisted queue (`app/lib/diagnostic-queue.ts`).** The piece that makes a
  FAILED LAUNCH visible: during one there is no session yet, or the process is
  about to die, so "POST it now" is exactly the strategy that does not work.
  The report is written to the same storage seam as the session
  (`app/lib/token-storage.ts`, key `neutron.diagnostics.queue`, outside
  `clearAll()`) and delivered on the next launch that authenticates
  (`app/components/DiagnosticsSync.tsx`). Bounded at 20 reports / 256 KiB,
  newest-wins. **A report is only dropped deliberately**: delivery is chunked to
  the gateway's batch cap and pruning is driven by the server's reported
  `accepted` count (not by a 200), every read-modify-write is serialised behind
  a lock so two concurrent crash captures cannot overwrite each other, and an
  oversized report is shrunk to a deliverable size — the gateway enforces its
  body ceiling before sanitising and answers 413, so one left at the head of the
  queue would 413 every flush forever. Pruning matches by `report_id` against a
  re-read, so a report enqueued during the flush is not destroyed.
  Each report also carries the `origin` gateway it was captured against and is
  delivered ONLY there: the queue outlives a server change on purpose, so
  without that a report from one instance would be handed to the next instance
  the owner configured. A foreign-origin report is retained (never deleted) and
  simply never travels; `origin: ''` — a crash inside the first-run setup gate —
  belongs to the first server configured, by definition. The gateway discards
  the field: it is client-side routing, and the instance knows which one it is.
- **Ingest (`gateway/http/app-diagnostics-surface.ts`).** `POST` + `GET
  /api/app/admin/diagnostics/reports`, on the same surface (and the same
  already-mounted `appDiagnostics` route slot) as the O5 read route, behind the
  same owner gate — `resolveBearer` + the instance-slug cross-check, wrong slug
  → 403, everything else → 401. **There is no unauthenticated write path**;
  requiring the bearer is exactly why the persisted queue exists, and an
  anonymous POST would be an open log-injection sink. Body ceiling 128 KiB,
  enforced before `JSON.parse`. The gateway redacts AGAIN on arrival
  (`gateway/diagnostics/client-report-redaction.ts`, an independent
  implementation) so a client that is old, modified or buggy still cannot write
  a token to the host, and it stamps the server-observed `user_id` and
  `received_at` rather than trusting the payload.
- **Where an operator reads it.** `<owner_home>/diagnostics/client-reports.jsonl`
  — one JSON object per line, trimmed to the newest 500
  (`gateway/diagnostics/client-report-store.ts`):

  ```sh
  tail -n 5 ~/.neutron/diagnostics/client-reports.jsonl | jq .
  ```

  The same history is available over HTTP at `GET
  /api/app/admin/diagnostics/reports?limit=…` with an owner bearer.
- **Manual push.** Settings → Diagnostics → "Send diagnostics" snapshots the
  current window and delivers everything queued, for "it is misbehaving right
  now" — which no automatic trigger can know about.
- **A non-crash failure can file a report too (`app/lib/push-observability.ts`,
  ISSUES #487).** Push registration is designed never to throw — it returns a
  typed result — so a phone that silently stops receiving anything produces no
  js_error, no rejection and no crash. The fifth `ReportReason`,
  `push_registration_failed`, exists for exactly that shape: `enablePushForUser`
  records EVERY outcome into the ring buffer and, for an actionable failure
  (`permission_denied`, `no_project_id`, `token_error`) also captures a report,
  so it travels. `unsupported_platform` — the web build, where native push does
  not exist — is recorded but never escalated, or a browser session would bury
  the real failures. The token itself is never recorded; a success carries the
  platform and the token's LENGTH. Login calls this BEFORE `setUser`, so
  `DiagnosticsSync` flushes the queued report on the same launch that produced
  it.
## Login-first instance discovery — `app/lib/identity-client.ts`, `app/app/login.tsx`

**The app opens on LOGIN and learns its own address.** Ryan: *"why does it have
to ask? it should just open with a login screen, and once you login it should
know the url."* ISSUES #385 gave the app a runtime server URL but made TYPING
it the first-run surface; this replaces that as the normal path. The typed-URL
form is not deleted — it is demoted to the self-host lane, because a
self-hoster runs no central identity service and so has nothing to discover
from.

**The happy path involves zero typing of addresses:**

1. An unconfigured install mounts the Stack and lands on `/login`
   (`app/app/index.tsx` redirects there while there is no server OR no
   session). A CONFIGURED, signed-in install lands on a chat route instead —
   see § "Mobile ENTRY" (the projects-list screen is deleted).
2. The owner signs in — EITHER lane:
   - **provider:** `POST {auth_base}/v1/oauth/<google|apple>/start`
     `{redirectUri}` → `{authorizeUrl, state, codeVerifier}`, consent in
     `expo-web-browser`, then `POST …/exchange` `{code, redirectUri,
     codeVerifier}`;
   - **password:** `POST {auth_base}/v1/login` `{email, password}`.

   Both return `{account, accessToken, refreshToken}`. BOTH are required: an
   account created through the provider front door is stored with no usable
   password hash and there is no password-set or reset endpoint, so a
   password-only client strands that owner permanently.
3. `POST {auth_base}/v1/route` with that bearer → `{slug, publicUrl,
   upstreamUrl, accessToken, claims}`.
4. `publicUrl` is adopted as the gateway base via `commitServerConfig`, the
   instance-scoped token becomes the session, and the app enters.
5. On later launches `app/app/index.tsx` RENEWS that session if it has aged
   out — see "Session renewal" below — so step 2 does not recur daily.

`auth_base_url` comes from config only (`extra.neutron_auth_base_url` →
`EXPO_PUBLIC_NEUTRON_AUTH_BASE_URL`); nothing is hardcoded, and the public repo
carries no hosted hostname. **The server side of this already existed** — both
endpoints live in the Managed control plane; the app only consumes them.

- **`publicUrl` is the ONLY address the app may adopt, and `upstreamUrl` is
  never read.** `upstreamUrl` is the identity service's INTERNAL reverse-proxy
  target (`http://127.0.0.1:<port>`), meaningful only to processes on the box.
  A phone that adopted it would dial its own loopback — precisely the #385
  bug. `discoverInstance` projects the reply down to `{slug, publicUrl,
  accessToken, userId}`, so the loopback field never leaves the module and no
  caller can pick the wrong one. A reply carrying only `upstreamUrl`, or an
  unparseable `publicUrl`, is an honest error rather than something salvaged.
- **Two DIFFERENT tokens.** The sign-in `accessToken` is ACCOUNT-scoped (`sub`
  only) and its sole purpose is authenticating the `/v1/route` call — it is
  never persisted and never sent to a gateway. `/v1/route`'s `accessToken` is
  INSTANCE-scoped (`sub` + `slug`) and is what becomes the persisted session.
  The gateway verifies it in the app-ws resolver's `jwks` mode — see
  § "Identity-service bearers (`jwks` mode)" below, which is what makes this
  bearer usable at all.
- **The persisted identity is the token's `sub`, never the instance slug.** A
  slug names a machine; `AuthUser.id` keys identity-derived state, including the
  `app:<user>` topic a ZIP import announces in `X-Neutron-Topic-Id`, which the
  server parses a `user_id` back out of. `discoverInstance` reads `sub` off the
  bearer it returns (unverified — the instance is authoritative) and reports
  `null` rather than guessing when it is unreadable, in which case the screen
  falls back to the account id it already holds.
- **ORDERING: adopt, THEN persist the session.** `commitServerConfig` wipes the
  persisted session whenever the host changes, so persisting the instance token
  first would have it deleted moments later. `app/app/login.tsx` adopts the
  host, then `await`s the session write, and only then calls
  `setRuntimeServerConfig` — which bumps the epoch and remounts the tree,
  whereupon `AuthSessionProvider` re-hydrates the user from storage. The write
  is awaited (not fire-and-forget) precisely because that remount re-reads
  storage.
- **Every failure branch is a reachable state, never a spinner.** The
  identity service's error taxonomy is mapped on the BODY'S SHAPE first and
  status second: two distinct routing failures both answer 404, so status alone
  cannot tell them apart, but the discriminating field the service attaches
  does.

  | Server condition | HTTP | `IdentityFailure` | Screen |
  | --- | --- | --- | --- |
  | one active instance | 200 | — | enters the app |
  | several instances | 409 + `slugs` | `ambiguous` | picker; choosing re-calls `/v1/route` with that `slug` |
  | no instance yet | 404 + `userId` | `no_instance` | "No instance yet" + Check again |
  | slug not owned | 404 + `slug` | `not_owned` | actionable error + retry |
  | bad credentials / stale session | 401 | `unauthorized` | back to sign in |
  | offline / DNS / TLS / timeout | — | `unreachable` | actionable error + retry |
  | anything else | 4xx/5xx | `server` (real status) | actionable error + retry |
  | no `auth_base_url` in the build | — | `identity_not_configured` | honest notice + self-host path; NOTHING is fetched |

  Every branch is gated on the STATUS as well as the discriminating field: a
  5xx whose body happened to carry a `slugs` array would otherwise render an
  instance picker instead of a retryable error, turning a transient fault into
  a dead end. Anything unrecognised degrades to `server` with the REAL status
  rather than being mislabelled.

  **The mapping is a pure function, not component code.** `app/lib/login-stage.ts`
  owns the `Stage` union plus `nextStageForFailure`, `clearsSession`,
  `retryTargetForStage` and `retryLabelForStage`, because the app suite has no
  React Native mount harness and a decision inside a component can only be
  covered by grepping its source. That is not hypothetical: with the logic
  inline, the retry control's LABEL came from `stage.retry_discovery` while its
  ACTION branched on `session !== null`, so after a failed second sign-in the
  button read "Back to sign in" and re-ran discovery on the FIRST account's
  still-held token — and the grep-based test passed. The label is now DERIVED
  from the same predicate that performs the action, so the control cannot
  contradict itself. Retry re-runs discovery only when the stage says so AND a
  session is genuinely held, so a transient failure does not cost the password
  again and a refused credential is never re-presented.
- **Session renewal (`renewInstanceSession`, wired in `app/app/index.tsx`).**
  The instance bearer is short-lived, so without renewal "sign in once" would
  decay into "retype your password every day". The refresh token is persisted at
  sign-in under `neutron.identity.session` alongside the account id and the
  adopted slug (inside `clearAll()`, so signing out cannot leave behind a
  credential able to mint a new one; a corrupted row reads as ABSENT rather than
  being spent, because spending a garbage refresh token is treated server-side
  as theft and revokes the whole family). At launch, `exp` is read LOCALLY with
  no network call; only if aged out does the app `POST /v1/auth/refresh` → re-call
  `/v1/route` PINNED to the adopted slug (auto-routing could otherwise move a
  multi-instance owner's device to a different instance behind their back) → and
  store the new bearer plus the ROTATED refresh token. **Only a REFUSED
  credential signs the owner out**; offline and 5xx both defer and retry next
  launch, so being on a train at launch cannot log anyone out.
  **A rotation is never dropped, even on a failure.** Refresh tokens are
  single-use: the instant the service answers the refresh, the presented token is
  revoked and the reply carries its replacement. The route hop happens AFTER that,
  so every exit past it — including `deferred` and `sign_in_required` — carries
  `rotated_refresh_token` out to the caller, which persists it. Without that field
  a flaky route hop dropped the replacement, the next launch replayed the revoked
  token, the service read it as a reuse attack and revoked the whole family, and
  the owner was forced back to credentials permanently — inverting the train
  guarantee above into a permanent logout. The two writes are also SEQUENTIAL with
  the refresh token FIRST (never `Promise.all`): a partial write must not leave a
  new bearer beside an old revoked refresh token, whereas a fresh refresh token
  beside a still-valid older bearer simply renews again next launch.
  **Renewal runs once per app mount** (`renewAttempted`), so a session left open in
  the foreground past `exp` does not re-renew until relaunch: there is no
  AppState-resume or 401-triggered renewal hook yet, and only a cold start
  recovers. Bounded by a 24h access TTL and tracked as follow-up rather than fixed
  here, because the fix is a provider-level hook rather than a change to this path.
  A self-hosted
  install (no identity session persisted) is skipped entirely. (The reply also
  carries a `kind` string, which would be a more direct discriminator, but its
  values name a hosting-layer concept Open's vocabulary gate excludes from this
  public tree; the shape check is equally determined by the server's output.)
- **The self-host card is always mounted**, in every stage of the screen — it
  is the fallback FROM a discovery failure, from an unconfigured identity
  service, and from a stale persisted host with no session left to reach
  `/settings` with. It holds the typed-URL `ServerConnectForm` plus the
  dev-token paste lane (the token `neutron start` prints), and needs no
  session. When `auth_base_url` is absent the sign-in form is not rendered at
  all: the screen says identity is not configured and points at this card,
  gated on the SAME predicate the client uses (`isIdentityConfigured`), so it
  can never offer a form the client would refuse to send. It IS locked while
  discovery is in flight (`busy || devBusy`): both lanes write the same
  persisted server config, and saving a LAN host mid-discovery would let the
  in-flight adopt overwrite it with a stale `previous_gateway_base_url`,
  corrupting the host-changed session-wipe bookkeeping. One writer at a time.
- **Release gate — the identity base is an EAS environment variable.** `auth_base_url`
  resolves from `extra.neutron_auth_base_url` → `EXPO_PUBLIC_NEUTRON_AUTH_BASE_URL`
  and `app/app.json`'s `extra` deliberately carries NO hostname (a baked instance
  or identity URL is Ryan-locked out of this repo, and `scripts/ci/leak-gate.sh`
  enforces it). A build whose EAS environment lacks
  `EXPO_PUBLIC_NEUTRON_AUTH_BASE_URL` therefore renders the honest
  "no identity service configured" card and offers only the self-host path — i.e.
  it opens on exactly the type-your-address experience login-first removes. **Check
  the variable is present (`eas env:list --environment <env>`) before shipping a
  preview or production build.** UNVERIFIED in-repo by construction: the value
  lives outside it.
- **Tests.** `app/__tests__/login-first-discovery.test.ts` drives the real
  client over an injected `fetch` and the real persist path, covering every row
  of the table above, plus: the persisted base is `publicUrl` and contains no
  `127.0.0.1` even though the fixture reply carries the loopback
  `upstreamUrl`; the picker's re-call payloads are `[{}, {slug:'beta'}]` and
  the CHOSEN instance's URL is what persists; a hung service settles instead of
  spinning; and an unconfigured `auth_base_url` fetches nothing at all. The
  final hop (persisted → synchronous `loadAppConfig()`) is asserted in
  `server-config-wiring.test.ts`, the one app test permitted to virtualize
  `expo-constants`.

## Identity-service bearers (`jwks` mode) — `channels/adapters/app-ws/auth.ts`

**The gateway side of login-first: how an instance verifies a bearer minted by
someone else.** A remote client has no way to learn `appWsToken` (the
per-install owner bearer the served web page is handed); it signs in at an
identity service and receives an RS256 token scoped to ONE instance slug. Until
this mode existed there was no resolver that could verify such a token — the
three modes were dev-bypass, HS256 and unconfigured — so login-first sign-in
succeeded and then every authenticated request 401'd. Because the flow's own
adoption probe is UNAUTHENTICATED `GET /healthz`, that failure was invisible
until a real request was made.

- **Configuration.** `NEUTRON_IDENTITY_JWKS_URL` names the identity service's
  published JWKS (conventionally `…/.well-known/jwks.json`); optional
  `NEUTRON_IDENTITY_AUDIENCE` adds an `aud` check. Verification is OFFLINE and
  keyless-on-our-side: jose's `createRemoteJWKSet` owns the fetch, the
  in-process cache, rotation-triggered re-fetch and its own cooldown, so no
  shared secret is distributed and no cache is maintained here. A malformed or
  non-http(s) value **throws at composition** rather than degrading to
  "identity quietly off" — a typo must not reproduce the sign-in-then-401
  confusion this mode removes. Unset is the normal SELF-HOST case.
- **PRECEDENCE: `jwks_url` outranks `bypass`, then `hs256_secret`, else
  unconfigured.** Exactly ONE mode is live per process and there is deliberately
  no credential CHAIN — a token that fails the configured mode is rejected, not
  retried against a weaker one. The ordering is load-bearing rather than
  arbitrary: `bypass` is derived from a LOOPBACK bind, and a hosted instance
  binds loopback behind a reverse proxy, so checking `bypass` first would make
  the production mode unreachable on precisely the deployments that need it.
- **The claim contract (all four required).** RS256 signature against a key in
  the JWKS; `exp` in the future; a non-empty `sub`; and a non-empty `slug` claim
  that **constant-time-equals** this gateway's own slug (ISSUE #34 — a byte-wise
  `!==` leaks this instance's slug prefix through response timing). **A token
  carrying NO `slug` is REFUSED**: that is the ACCOUNT-scoped bearer every
  signed-in account holds, whose only job is to ask "where is my instance?", and
  accepting it would let any account drive any install.
- **Identity normalisation (`appOwnerAuth`, `open/composer.ts`).** The resolver
  returns the identity service's account id as `user_id`, but Open is
  single-owner and everything downstream — the WS channel topic, the
  owner-timezone write, every `/api/app/*` gate — compares against
  `OWNER_USER_ID`. Returning the remote account id would authenticate the owner
  and then deny them, and would fork the chat transcript per account id. Since
  the control plane mints a slug-scoped token only for that slug's owner, and the
  resolver already checked the slug, that bearer IS the owner:
  `if (resolved.mode === 'jwks') return { ...resolved, user_id: OWNER_USER_ID }`.
- **Tests.** `channels/adapters/app-ws/__tests__/auth.test.ts` covers the claim
  contract with an INJECTED key set (the fetch/cache/rotation behaviour is
  jose's, not ours), including that `jwks_url` wins over `bypass: true`.
  `tests/integration/identity-jwks-bearer.open.test.ts` is the WIRED + SERVED
  proof: it builds the REAL composed graph, stands up a REAL HTTP JWKS endpoint
  on an ephemeral port, and drives `/api/app/chat/send` — an instance-scoped
  token gets exactly 200 + `{ok:true}`, while account-scoped / wrong-slug /
  expired tokens each get 401.
- **Optional hardening.** `NEUTRON_IDENTITY_AUDIENCE` pins the required `aud`
  and `NEUTRON_IDENTITY_ISSUER` pins the required `iss`. Both are opt-in
  because their values are one deployment's vocabulary. The authorization that
  always applies is the `slug` cross-check; the `iss` pin matters once an
  instance trusts more than one key source, where signature + `slug` alone
  would accept a token from any issuer in the set.
- **Known gap — the hosting layer must still supply the env var.** Open can
  verify the bearer; the identity service must thread
  `NEUTRON_IDENTITY_JWKS_URL` into each instance's environment. That is a
  hosting-layer change in the private overlay repo (one repo per PR: Open
  first, then the overlay re-pins). Until it lands, an instance behind a proxy
  still rejects the app's discovered bearer — sign-in succeeds and every
  authenticated request 401s.
  **The refusal now names itself.** An instance behind a reverse proxy binds to
  loopback, so `bypass` is on there by derivation; with no JWKS configured the
  app's RS256 bearer lands in the dev-bypass lane, which cannot verify it. It is
  still correctly refused (there is no bypass of verification), but it used to be
  refused as *"dev token is empty or too long"* — a message naming nothing the
  operator did. `resolveDevBypass` now shape-detects a JWT and returns
  `unconfigured` with the variable to set, so the misconfiguration is
  self-diagnosing from a single log line instead of a mystery 401.
- **Why `bypass` sits BELOW `jwks`, and what that costs.** Configuring a JWKS is
  the operator's statement that real identity is live, so it outranks the dev
  lanes — otherwise a loopback-bound instance could never accept the app's
  bearer. The consequence is that once JWKS is enabled the dev-token lanes stop
  being usable on that instance: the web client's `dev:<user>` fallback in
  `landing/chat-react/config.ts` and the mobile self-host dev-token paste in
  `app/app/login.tsx` are both rejected there. Neither degrades in practice —
  `open/wiring/owner-gate.ts` injects the real app-ws token into every gated
  page, and the owner-bearer equality check in `open/composer.ts` runs
  mode-independently ahead of the base resolver — so this is a fallback-only
  regression, not a live one.

## Tab resolver (WAVE 3 tabbed shell) — `tabs/` + `gateway/http/app-tabs-surface.ts`

The project (and global) tab set is resolved **engine-side** so both clients
(mobile RN + web React) consume one source of truth instead of hardcoding
their tabs. `tabs/registry.ts` exposes a `TabDescriptor` (`key`, `label`,
`scope: 'project'|'global'`, `source: 'builtin'|'core'`, `order`,
`mount: { kind: 'builtin'|'webview'|'app_route', target }`) and a
`resolveTabs(scope, cores)` resolver. **BUILTIN descriptors** — Chat /
**Work** (`work_board`, label "Work") / Documents / **Apps** (`launcher`) /
Settings per-project (orders 0/5/10/12/15), Admin global — are
unioned with **CORE-contributed tabs** (PR-2), shaped as `source:'core'`,
`key:'core:<slug>'`. The registry
stays **pure** (no DB / no package loading) — the HTTP layer resolves which
Cores are installed and passes a `CoreTabContribution[]` in.

> **Tasks is NOT a builtin tab** (Ryan directive, 2026-06-30). The `tasks`
> `BUILTIN_TABS` entry was removed; Tasks returns as a **Core-contributed
> tab** through the `CoreTabContribution` union. Do not re-add a hardcoded
> tasks builtin.

### The two Core contribution surfaces — `project_tab` vs `app_tab`

A Core's manifest `ui_components[]` can contribute a tab two ways, and they mean
different things:

| manifest `surface` | descriptor `mount.kind` | `target` is | rendered as |
|---|---|---|---|
| `project_tab` | `webview` | the `entry_point` URL | sandboxed iframe / system browser |
| `app_tab` | `app_route` | `props_schema.properties.path.const` | the client's OWN native screen |

**`app_tab` reads the manifest's `props_schema`, never `entry_point`** — an
`app_tab`'s entry_point is a SOURCE FILE inside the Core package
(`./src/ui/app-tab-surface.ts`), meaningless to a client. `label` and `order`
come from the same `props_schema` consts (falling back to the launcher-icon
label, then the slug). A declared `order` competes directly with the builtins,
which is how Tasks (order 30) sorts after Settings (15) instead of landing in an
arbitrary install slot; a Core with no `order` falls back to
`CORE_TAB_ORDER_BASE + index`.

This distinction is why "pass `cores` into the surface" was NOT the fix for
Tasks being unreachable: **every bundled UI Core declares `app_tab`**, so a
resolver matching only `project_tab` returned `[]` no matter what was passed in.

### The renderability rule (cross-client contract)

The engine resolves ONE tab set for every client, but the clients do not
implement the same screens — web has no Apps launcher, and a Core may ship a
screen only one client has. **Each client MUST DROP any descriptor it cannot
render** (an unknown `builtin` target, or an `app_route` path it has no screen
for) rather than seating a tab that opens onto an empty pane. Capability is the
client's call; the engine does not guess.

- Mobile: `canRenderTab` + `RENDERABLE_ROUTE_LEAVES` in `app/lib/project-tabs.ts`.
- Web: `canRenderTab` + `APP_ROUTE_VIEWS`/`BUILTIN_VIEWS` in `landing/chat-react/tabs-client.ts`.

### Late-bound Cores registry (the seam that makes Core tabs resolvable)

`open/composer.ts` builds the tabs surface long BEFORE `graph.compose()` runs, so
the Cores registry does not exist yet at construction time. The surface therefore
takes `cores` as a **getter** (`() => CoresModuleState | null`) read PER REQUEST,
and the composer seeds it from the post-compose `on_cores_ready` hook that
`wireCoresSurfaces` fires. Reading the value at construction would latch the
pre-compose `null` forever — which is precisely the defect that left Core tabs
permanently empty in Open.

Two read-only HTTP routes (Bearer-auth, shared `AppWsAuthResolver` contract):
- `GET /api/app/projects/<project_id>/tabs` → builtins ∪ per-project Cores
  (from `core_installations`); `<project_id>` substituted into Core targets
- `GET /api/app/tabs`                        → builtin Admin ∪ globally-installed
  Cores (from `core_global_installations`)

**Always on — no feature flag** (SPEC Decisions Log, 2026-06-23). The surface
disclaims its routes (returns `null` → 404) only for non-owned paths. Surface
factory: `createAppTabsSurface({ auth, cores?, installations? })` where `cores`
is a `() => CoresModuleState | null` getter (Core union is opt-in — omit
`cores`/`installations`, or resolve null, for a builtin-only surface), plumbed
via `app_tabs_surface` in `AppSurfacesCompositionInput` → `composition.ts` →
`compose.ts` (`appTabs`, mounted ahead of `appProjects`).

### Mobile client consumption (WAVE 3 PR-3)

The Expo project shell (`app/app/projects/[id]/_layout.tsx`) is **registry-driven**:
on mount it fetches `GET /api/app/projects/<id>/tabs` via `app/lib/tabs-client.ts`
and feeds the resolved descriptors into `ProjectTabBar`'s `tabs` prop — no
hardcoded set. `app/lib/project-tabs.ts` (RN-free, unit-tested) maps each
descriptor to a route + active-highlight key: **builtin** descriptors render the
native expo-router leaf (`mount.target` = `chat`/`workboard`/`docs`/`launcher`);
**`app_route`** descriptors navigate `mount.target` VERBATIM (the engine already
substituted `<project_id>`, so it is a complete expo-router path — no
re-prefixing); **Core webview** (`mount.kind:'webview'`) descriptors route to the
generic `app/app/projects/[id]/cores/[slug].tsx` webview (inline `<iframe>` on
web, system browser via `expo-web-browser` on native — no `react-native-webview`
dep). Descriptors this client cannot render are dropped (renderability rule
above). The legacy `PROJECT_TABS` const survives ONLY as the pre-fetch loading
default (and the on-error fallback) — not a flag-gated path.

**Apps (launcher) is a builtin again (order 12).** It had been dropped from the
registry while surviving in `PROJECT_TABS`, so the tab appeared for one frame and
then VANISHED the moment `/tabs` resolved — taking with it the only live route to
the Core screens it fronts. Reminders/Tasks routes remain reachable by deep-link
and, for Tasks, as a Core-contributed `app_route` tab. The web shell consumption
is PR-4 (reworked 2026-06-30 — see below).

### Mobile ENTRY: the app opens in chat, and the projects-list screen is deleted (2026-07-29)

**Ryan-locked, SPEC § Decisions Log 2026-07-27** (recorded then, implemented
2026-07-29 after he hit the old screen again): *"I don't want this screen shown.
It should just open into the general chat with the rail on the left. Delete this
screen completely."* Mobile now has ONE entry path and no list screen.

- **`app/app/index.tsx`** resolves the entry route through
  `resolveEntryRoute` (`app/lib/entry-route.ts`) instead of redirecting to
  `/projects`: `GET /api/app/projects` → most-recently-active NAVIGABLE project →
  `/projects/<id>/chat`. Empty list, an all-`shared` list, or ANY fetch failure
  resolves to **General** (`/projects/~general/chat`) — the no-project scope needs
  no fetch, so an offline launch never strands the owner on a spinner. The
  decision lives in a pure function, not a `router.replace` literal, so
  `app/__tests__/mobile-entry-route.test.ts` can fail when it drifts (it drifted
  for two days precisely because nothing asserted it).
- **`app/app/projects/index.tsx` is DELETED**, along with its
  `<Stack.Screen name="projects/index" />` registration. Nothing in the app
  navigates to `/projects` any more; the enumerating test above enforces that.
- **The rail IS the switcher** (see the next section), and its `+` now opens
  `<CreateProjectSheet>` (`app/components/CreateProjectSheet.tsx`) OVER the chat
  — no navigation, no separate screen. Submit → `POST /api/app/projects` →
  `/projects/<new-id>/chat`. The name rule + error copy are pure
  (`app/lib/create-project-helpers.ts`). Deleting the list screen without this
  would have removed the only way to create a project on mobile.
- **`/settings` and `/admin` were re-homed.** The deleted list header was the ONLY
  place in the app that pushed either (the ISSUES #385 defect class). The project
  shell header's LEFT slot is no longer a back arrow to the list — it is the
  app-level entry (`☰` → `/settings`, testID `project-header-app-settings`), and
  `/settings` gained an **Admin** row (`settings-admin` → `/admin`). Sign-out
  already lived on `/settings`. `app/__tests__/server-editor-reachability.test.ts`
  now pins THAT path.
- Every remaining ex-`/projects` hop (project-not-found fallbacks, the Focus
  screen's owner-level items and its header link, Admin's back button) targets the
  General chat.

### Mobile rail + seated tabs + Work-badge (M1 UX REDESIGN PR-6)

The Expo project workspace (`app/app/projects/[id]/_layout.tsx`) now seats a
**Telegram-folder-style project rail** on the LEFT edge (`app/components/ProjectRail.tsx`):
each entry is the project **emoji with the project NAME directly below it** (not
emoji-only, per Ryan's sign-off override of the prototype's icon rail) plus a
per-project **work-activity dot** on the emoji corner — `working` → pulsing
`--work` @2.4s (reduced-motion-gated), `attention` → static `--attention`, `idle`
/ General → none. The active project is highlighted; tapping switches project. The
dot-choice is the pure `railDotKind` (`app/lib/project-rail-view.ts`, unit-tested).

The tab band is now **seated** (`ProjectTabBar` `NarrowTabBar`): tabs are
top-rounded sheets on a `surface` band and the active tab fuses to the content
sheet (mirrors PR-3's desktop treatment). The **Work tab** carries a **live-run
badge** (`live_runs` count, phase-build tinted) — the registry emits no Work
descriptor, so the shell injects a Work tab after Chat over both the loading
default and the fetched set (`ensureWorkTab`, one code path), routed to the
existing `workboard.tsx`.

**Rail data source (no re-derivation).** The rail's project SET comes from the
HTTP list (`fetchProjects`); the PR-1 `activity` + `live_runs` overlay comes LIVE
from the app-ws `projects_changed` frame — the SAME frame the web rail consumes,
so the composer stays the single source of truth. A minimal server change makes
`on_session_open` push the current snapshot straight to the just-connected topic
(`open/composer.ts`) so a freshly-connected mobile socket seeds its rail on open
rather than waiting on the global diff-gate. Subscriber:
`app/lib/projects-rail-live.ts` (mirrors `work-board-live.ts`, injectable socket).

**The chrome is PERSISTENT — it does not unmount on a project switch (2026-07-29).**
The rail, the header and the tab bar are mounted for the whole life of the
`/projects/[id]` layout; only the **content pane** has a loading state. `ProjectShell`
therefore returns UI from exactly ONE place and has no early return above the
chrome. Until 2026-07-29 it gated the whole shell on the settings fetch
(`if (project === null) { if (loading) return <spinner/> … }`), so every rail tap
tore the rail, header and tab bar down and rebuilt them when the fetch resolved —
which is what Ryan felt on device as flicker and lag, not slow rendering.

Three pieces hold that invariant:

- **`app/lib/project-shell-content.ts`** — the content-pane decision as a pure
  function (`ready` / `loading` / `not_found`), so it is assertable the way
  `entry-route.ts` is. The **error**, not `loading`, decides `not_found`: on the
  render where the route flips the fetch effect has not run yet, so `loading` is
  still false while `project` is already null for the new scope, and the old gate
  rendered "Project not found" in exactly that gap. `projectStateReducer` attaches
  an error to every `LOAD_FAIL`, so a genuinely absent project always reaches the
  not-found pane — which now renders INSIDE the chrome, leaving the rail available
  to tap out of the dead end.
- **`scopedProjectState`** (`app/lib/project-state-reducer.ts`, applied in
  `project-state.tsx` against a `loadedScope` marker) — the provider is reused
  across `project_id` changes (keying it would unmount the very chrome this fixes),
  and `LOAD_START` deliberately preserves `project` so a `refresh()` does not blank
  the UI. Together that meant project A → B rendered B's shell under **A's name**,
  and General → a real project flashed "Project not found" from the 404 collected
  for `getSettings('general')`. Data whose scope is not the requested one now reads
  as "nothing known yet, fetch in flight".
- **`SlotFader` takes a `scopeId`** and re-baselines without animating when it
  changes. The fade is for tab switches within a project; a rail tap travels
  `/projects/<id>` → `/projects/<id>/chat`, so keying it on the route leaf alone
  fired two opacity dips per switch on top of the content pane's own spinner.

While the doc is in flight the header names the project from the already-loaded
rail list (`scopeName`), and the Invite pill is suppressed — the predicate reads
`billing_mode` + `members` and there is no honest answer without them.

**A rail tap is a TAP, not a load (2026-07-31).** Keeping the chrome mounted
stopped the teardown; it did not stop the shell asking the wire for things it was
already holding. Filmed at 30 fps on the release APK, every switch still produced
four to six repaints and ~800 ms between finger-up and a settled screen. Three of
those repaints came from re-resolving known answers, and each is now resolved
before the tap:

- **The settings doc is already on the device.** `GET /api/app/projects` — the
  rail's own call — returns `ProjectListEntry extends ProjectSettings` for every
  solo project, read from the same `projects` table and `project_members` join
  that the per-project GET uses. `ProjectsClient` files every settings doc it
  receives (read, privacy, rename, emoji) into
  **`app/lib/project-settings-cache.ts`**, `fetchProjects` files every **solo**
  list row, and `ProjectStateProvider` starts a scope from that doc instead of
  from nothing. The authoritative fetch still runs and still replaces it, and a
  scope that has genuinely not been fetched still gets the loading pane — the
  cache removes a wait, it never invents a scope. **Solo only:** a `shared` row's
  settings fields are gateway-filled defaults, so caching one would be the
  fabrication ISSUES #393 banned.
- **The tab set is per scope and is never blanked.** `_layout.tsx` held one
  `fetchedTabs` that a switch reset to `null`, so the pre-fetch default (Chat /
  Apps / Tasks / Reminders / Docs) flashed for 3–4 frames of every tap. It is now
  a `Map<project_id, TabDescriptor[]>`: the reset is gone, and with it the reason
  for the reset (a lookup by id cannot return the previous project's routes). The
  shell also prefetches the tab set for the rail's top `TAB_PREFETCH_LIMIT`
  projects, 600 ms after the list lands so it never contends with the first
  paint.
- **The destination route is resolved synchronously.** `LastTabStore` keeps an
  in-memory mirror of every value it has read or written and exposes
  `knows()` / `peek()` / `prime()`; `projectTabRouteSync` turns a tapped id into
  its route with no `await`, so `router.replace` runs in the same tick as the
  press. A miss returns `null` and the caller falls back to the async read rather
  than guessing a tab.

Separately, `useMobileChat` no longer settles hydration on the seeded socket
status at attach time — that declared the transcript loaded while `messages` was
still empty, so a warm re-attach flashed "No messages yet. Say hello 👋" over a
project with full history. The store read that follows settles it with the
messages in hand, and the hydration floor still guarantees the spinner comes
down.

Pinned by `app/__tests__/project-switch-is-instant.test.tsx`, which forces each
"already answered" case and then makes the corresponding request never come back.

### Background transcript warmer (2026-07-31) — `app/lib/chat-core/transcript-warmer.ts`, `use-transcript-warming.ts`

The work above left one residual, reported rather than hidden: on a scope this
device has **never visited** there are no rows in the on-device store, so
`hydrationSettled` takes its `status === 'open'` branch the moment the socket
comes up (`chat-render-model.ts`), the surface renders "No messages yet. Say
hello 👋", and the resume replay lands a beat later and replaces it. The empty
state is not wrong, only premature — and the protocol has no resume-complete
frame to gate it on. Ryan: *"pre-cache everything in the background. First
download the active project, but as you have time in the background just download
all the other tabs etc so switching is instant."*

So the transcript is pulled **ahead of the tap**. Of the three things a switch
needs, the other two were already warm before it happened — the settings doc
(filed from the rail's own list) and the tab set (`TAB_PREFETCH_LIMIT`) — and the
transcript was the last one still fetched on arrival.

**The seam is the existing session, not a new cache.** A warm is
`acquireSession(topic)` → `start()` → `session_ready` → `resume(after_seq)` →
`applyInbound` → the ONE device-wide op-sqlite store — the exact path a real
visit uses, so no sync logic is duplicated and no second copy of anything exists.
The reference is released immediately afterwards; `releaseSession` does not
disconnect, and the LRU keeps at most `MAX_WARM_SESSIONS = 3` sockets, so warming
eight scopes does **not** leave eight sockets open. The socket was never the
point — the rows it pulled stay on disk after its eviction, which is what buys
the next visit.

**Bounds, and why.** `WARM_SCOPE_LIMIT = 8` scopes (the rail is activity-sorted;
a ninth project opens exactly as it does today), the active scope excluded, one
warm at a time, `WARM_FIRST_DELAY_MS = 2000` after the rail lands and
`WARM_GAP_MS = 750` between scopes so eight never arrive as a burst at a gateway
the owner is also talking to. Bytes per scope are bounded by the server, not the
client: a cold resume replays at most `DEFAULT_REPLAY_LIMIT = 500` messages per
topic (`persistence/app-chat-store.ts`). There is deliberately **no wifi-vs-
cellular gate** — that needs a native network module, which would cost the
OTA-shippability of everything in this section; the bound above is what makes
cellular acceptable instead.

**The yield is the load-bearing part.** A prefetch that delays the transcript the
owner is waiting on has made the app slower at the one interaction it was built
to speed up, and it would do so with no symptom at all. So: nothing is dequeued
while the visible chat is hydrating (`useMobileChat` raises the claim on attach
and lowers it when that scope settles — every settle path, including the floor
timer and the failed-attach path), and a warm already in flight **abandons
itself** on the gate transition rather than at its next budget boundary.
`AppState` backgrounding suspends the schedule outright.

**Staleness.** Nothing marks a scope "done". A visit to a warmed scope still
drives `start()` unconditionally and still issues `resume` from the local cursor,
so the warmed rows are a floor and everything appended since arrives on exactly
today's schedule; `reconcileServerReset` still drops a transcript whose server
has been wiped. The warm can be stale by minutes without ever being wrong —
the owner sees real messages instantly and the tail fills in behind them, instead
of seeing an empty state and then real messages.

**Not warmed, stated rather than implied:** Docs and Tasks tab BODIES. Each is a
per-mount hook chain (`app/features/docs/`) with no shared cache to fill, so
warming them would mean inventing a second cache per surface for a flash nobody
has measured.

Measured in the mobile harness (`app/__tests__/transcript-warmer.test.ts`),
filming the real surface at 30 fps over an 800 ms replay delay: the cold scope
shows the empty state for **22 of 36 frames (~726 ms)**; the same scope warmed
first — with its warm session then cleared, so the win comes from disk and not
from a live socket — shows it for **0 of 36**. Harness, not glass: the frame
counts are real commits, the device-side number is unverified. The three
yield guarantees are mutation-tested in the same file.

### Web client consumption (WAVE 3 PR-4)

**Tab body dispatch** (`landing/chat-react/ProjectShell.tsx` `TabContent`): a
`webview` mount renders a scheme-validated sandboxed `<iframe>`; an `app_route`
mount selects a React view by the TERMINAL SEGMENT of the path (`/projects/<id>/
tasks` → `tasks` → `TasksTab`, wrapped in a `PaneErrorBoundary`); everything else
dispatches on `mount.target` (`docs`/`workboard`/`admin`/`settings`). The fetched
descriptor list is filtered through `canRenderTab` BEFORE it reaches the bar, so
the web never seats the Apps launcher (no web screen) and never shows a
placeholder for a Core screen it lacks.

**`TasksTab.tsx` + `tasks-client.ts` (web Tasks).** The browser twin of the
mobile `app/app/projects/[id]/tasks.tsx`, over the SAME
`createAppTasksSurface` endpoints (`GET/POST /api/app/projects/<id>/tasks`,
`PATCH|DELETE .../tasks/<task_id>`, `POST .../complete|/cancel`) and therefore
the same canonical `TaskStore` rows the agent's `tasks_core` tools write — one
data path, no web-only store. Filter chips (Open/Done/All), inline add,
complete/reopen, delete. Server-authoritative like mobile: every mutation awaits
its response then re-lists (`order=focus_score`), so both clients rank
identically. Styled with the pre-existing `.ctask-*` block in `chat-react.html`.

> These two files were deleted in the 2026-06-30 "Tasks is not a builtin" change
> and are restored here as the CORE-CONTRIBUTED tab's web view — the tab is still
> not a builtin; only the screen behind the Core's `app_route` is back.

> **P0b (2026-06-26) — React is the ONLY web chat client.** The vanilla
> `landing/chat.ts`/`chat.html` surface and the `NEUTRON_WEB_CHAT_CLIENT` /
> `?client=` flag (`landing/web-chat-flag.ts`) were **deleted** (no feature flags,
> no dual path). `GET /chat` now unconditionally serves `chat-react.html`
> (ProjectShell → persistent rail + tabbed content); `chat-react.html` is
> required at boot (`landing/server.ts` + `landing/boot.ts` throw if missing) and
> `/chat-react.js` is the only served client bundle (`compose.ts` `LANDING_PATHS`).
> A fresh single-owner Open install serves the tabbed React UI with no env var.
> Beyond the exact `/chat` path + `LANDING_PATHS`, a narrow **SPA catch-all**
> serves the same shell for `GET /projects[/…]` browser navigations
> (`landing/spa-routes.ts` `isSpaClientRoute`) so project-scoped deep links (doc
> URLs) are real navigable URLs — see the doc-link deep-link note below. It runs
> AFTER every API/asset/operator surface in the precedence chain, so it never
> masks a real 404.

> **UX Batch-4 (2026-07-03, #347/#348/#349/#350) — mobile chat-react polish.**
> The cold-start "Waking up…" notice is a single centered ephemeral pill that
> clears when the reply streams — never persisted or duplicated: the controller
> latches "reply started" to drop a late ack, filters any durable ack body out of
> the bubble list, and the gateway cancels the delayed ack on the first reply
> token (`collectTokensToString` `onFirstToken`). On mobile the `ProjectShell` top
> bar stacks the project title ABOVE the tab band, the light/dark control moved
> out of the tab bar (removed on all viewports) into General → Admin →
> **Appearance** (a labeled System/Light/Dark segmented control), and tabs that
> don't fit collapse into an accessible "⋯" overflow menu (`tab-overflow.tsx`)
> instead of scrolling horizontally. The mobile Work tab pulses build-blue while a
> build runs, and a transient top drawer (`work-activity.tsx` `JobStartDrawer`)
> slides down to announce a newly-started build (auto-retracts ~3s, swipe-up to
> dismiss). All mobile-gated at the `1024px` breakpoint; desktop unchanged.

> **Web-client rework (2026-06-30) — per-project chat + rail/tab layout +
> markdown.** Five linked changes to `landing/chat-react/`:
> 1. **Real per-project chat.** Each project owns its OWN app-ws topic. The
>    server (`app-ws-surface.ts`) binds a `platform=web` socket carrying a
>    `project_id` to the PER-PROJECT topic `app:<user>:<project>`
>    (`appWsProjectTopicId`, `channels/adapters/app-ws/envelope.ts`); General omits
>    `project_id` → bare `app:<user>`. Persistence + seq + resume + fan-out all
>    key on that topic string, while the agent loop scopes off the `project_id`
>    field (`open/composer.ts`), so each project gets an independent transcript. The
>    client (`controller.ts setProject`) RE-SCOPES on a project switch: it tears
>    down the socket and stands up a fresh one bound to the new topic, hydrating
>    that topic's transcript from the shared OPFS store (`main.tsx topicForProject`
>    / `wsUrlFor`). **Gated on `platform === 'web'`** — mobile keeps its single
>    `app:<user>` socket + `project_id`-field model, unchanged. Reminders/briefs
>    still fan to the bare `app:<user>` (General inbox) topic, so they surface in
>    General (durable rows under `app:<user>`), not the per-project chats.
>    **Mounted-per-conversation surface cache (#343).** `ChatApp` no longer
>    remounts the whole chat surface on a project switch (the old `key={convId}`
>    on the sole runtime host tore down thread + composer, flashed the empty
>    state, and dropped scroll/draft — the visible "rebuilding the screen"
>    flicker). Each visited conversation now gets its OWN persistent
>    `MountedConversation` (`.car-conv`) with its own assistant-ui runtime; only
>    the active one is un-`hidden`. A per-convId frozen-vm cache feeds each
>    surface ONLY its own conversation's messages (live when active, its last
>    snapshot when not), so the SEV1 index-out-of-bounds fix is preserved
>    structurally (no runtime is emptied in place by a foreign switch), scroll +
>    composer draft survive per project, and switching back to an open project is
>    instant (no refetch flash). Bounded by `MAX_MOUNTED_CONVERSATIONS` (LRU).
>    **Cross-project exception — the project rail.** The left rail is a
>    cross-project concern, so a `projects_changed` refresh (onboarding minting a
>    project, or the "Create Project" button / `create_project` tool) must reach
>    the client whatever project socket is active. `open/composer.ts`
>    `fanProjectsChanged` therefore fans that frame to the bare `app:<user>` topic
>    AND every live `app:<user>:<project>` topic (via `appWsRegistry.topics()`),
>    else creating a project from inside a project would only show up after a
>    reload (the #132 → this-fix bug).
> 2. **Persistent rail + tab layout.** `TopicRail` is lifted OUT of `ChatApp`
>    (which is now just the Chat-tab body) to a persistent left column in
>    `ProjectShell`; the `TabBar` renders in the content pane for BOTH views.
>    **General** = Chat + Admin (global tabs); **project** = Chat / Work /
>    Documents (NO Admin fold-in — the old bug).
> 3. **"Work Board" → "Work"** user-facing label (`tabs/registry.ts`; M1 UX
>    redesign renamed the earlier interim "Plan" to "Work"); internal
>    `work_board_*` / `cwb-` / DB table keep their identifiers.
> 4. **Tasks tab removed** from the engine (see the Tasks note above).
> 5. **Markdown** — agent chat bodies (`ChatApp` `TextPart`) + the Documents
>    viewer render sanitized GitHub-flavored markdown via `react-markdown` +
>    `remark-gfm` + `rehype-sanitize` (shared `Markdown.tsx`). The Documents tab
>    keeps a Rendered↔Source toggle so comment anchors still map to RAW offsets.
>    The Documents viewer passes `stripFrontmatter` (SEV1 M1, 2026-07-01) so a
>    doc's leading YAML frontmatter fence (`---\nkey: value\n---`) is hidden from
>    the RENDERED body via `stripLeadingFrontmatter` — it otherwise renders as a
>    bold run-on blob at the top of every doc (STATUS.md, README.md, …). The
>    Source view + chat surface leave frontmatter untouched (a bare `---`
>    horizontal rule with no closing fence is never stripped).

> <!-- SYNC-ON-DEPLOY (M1 UX REDESIGN PR-1, 2026-07-02) — flagged for the Managed
> orchestrator's SYSTEM-OVERVIEW sync. -->
> **M1 UX REDESIGN — backend data contracts (PR-1, 2026-07-02).** Two
> design-independent backend contracts the redesigned Work pane + rail consume
> (no visual change ships in PR-1):
> 1. **Per-run INNER-STEP + a live push (retires the 15 s poll).** A bound Work
>    item now derives a `run_progress.step_label` in the redesign's vocabulary —
>    `building → reviewing → fixing → merging` + terminal `done`/`failed`
>    (`trident/run-progress.ts` `deriveStepLabel`, mirrored client-side in
>    `landing/chat-react/work-board-client.ts`). It is DERIVED from the inner
>    workflow's `inner_checkpoint` (which `trident/inner-workflow.mjs` `checkpoint()`
>    already re-stamps at every phase boundary), since checkpoints are end-of-phase
>    markers (`forge-done`→reviewing, `argus-request-changes`→fixing,
>    `fix-round-N`→reviewing, `argus-approved`→merging, `pr-merged`→merging — #563's
>    terminal-on-merge checkpoint, so a shipped change never renders as still
>    building). CRITICALLY, the durable
>    tick loop (`trident/tick.ts`) now carries an `on_transition` hook: it re-loads
>    every non-terminal run each tick and, when a run's progress signature
>    (`phase|inner_checkpoint|round|pr|last_advanced_at`) advances, fans a
>    `work_board_changed` frame on the DETACHED inner workflow's behalf (the
>    workflow can only `sqlite3`-write, not reach the app-ws registry). The composer
>    wires `on_run_transition` → `fanWorkBoardChanged(run.project_slug)` +
>    `emitProjectsChangedIfChanged`. The client's 15 s board poll
>    (`WorkBoardTab.tsx`) is RETAINED only as a fallback + to tick the elapsed/stall
>    clock.
> 2. **Per-project RAIL fields.** `projects_changed` + the page bootstrap +
>    `readProjectRows` (`open/composer.ts`) now carry four derived per-project
>    fields: `activity` (`idle`/`working`/`attention` — working = a live chat turn
>    ∪ a live bound run ∪ an inline-active item; attention WINS = a failed-not-done
>    item ∪ a stalled live run), `preview` + `preview_from` (the last chat message,
>    markdown-stripped + server-truncated to ~90 chars, with the sender), and
>    `live_runs` (count of live bound runs, for the Work-tab badge). The pure
>    derivation lives in `open/project-rail.ts` (`deriveProjectActivity` +
>    `truncatePreview`); the live chat-turn signal rides the `agent_typing`
>    start/end seam. The client parses them in `controller.ts` / `config.ts`
>    (`ProjectTab`), all optional on the wire for back-compat.

> <!-- SYNC-ON-DEPLOY (trident parallel builds + lifecycle, 2026-07-03) — flagged
> for the Managed orchestrator's SYSTEM-OVERVIEW sync. -->
> **Trident/Work Board — parallel same-project builds + build lifecycle (2026-07-03).**
> Five Ryan-locked behaviours (no feature flags, one code path):
> 1. **3+ concurrent same-project builds now land.** Each build already runs in its
>    own worktree; the LOCAL merge (`trident/merge.ts` `mergeLocal`, serialized per
>    `repo_path` by `withLocalMergeLock`) now REBASES the build's branch onto the
>    latest base before merging, so the 2nd/3rd build replays on top of a sibling's
>    merge instead of hard-failing. A real content conflict dispatches a **bounded
>    Forge** (`trident/conflict-resolver.ts`, over the composer's ephemeral substrate)
>    to resolve it in the conflicted worktree; a genuinely ambiguous conflict
>    ESCALATES a specific question to chat (`TridentMergeConflictEscalation` →
>    `orchestrator.applyResult` fails the run with the question as its reason).
> 2. **A failed build shows FAILED (red) + keeps its run link.** The terminal
>    reconcile (`work-board/store.ts` `detachRun('failed')`) sets `status='failed'`
>    (new lane, migration `0097`) and KEEPS `linked_run_id`, so the client derives a
>    red dot + "Failed" tag + the run's `failure_reason` one-liner + the ▶/↻ retry —
>    instead of the old revert-to-upcoming-and-unlink (which lost the failure).
> 3. **Terminal builds announce in chat.** The tick loop's terminal delivery
>    (`trident/delivery.ts`) posts "✅ `<slug>` — build done, merged" / "❌ `<slug>` —
>    build failed: `<reason>`" to the originating chat via the run's `channel_kind`.
>    On Open (app_socket) delivery now goes through the durable **app-ws adapter**
>    sink (`open/composer.ts` → `trident.delivery_sink`) — the bare `ChannelRouter`
>    has no app_socket adapter, so completions were silently dropped. Board-dispatched
>    runs now carry the originating chat topic (`resolve_delivery` maps the tool
>    call's `project_id` → app-ws topic; the ▶ route + `/code` thread it too).
> 4. **Every build creates a trackable card.** The build-routing doctrine
>    (`gateway/wiring/operating-doctrine.ts`) now REQUIRES a Work Board
>    card for EVERY build — inline OR trident, any project — so no build is invisible.
> 5. **Underspecified builds ask in chat.** The ▶ route on an `underspecified`
>    rejection posts a short clarifying question to chat (`open/composer.ts`
>    `buildClarifyPoster`) and returns 200 (`work-board-surface.ts`) — never the raw
>    internal guard text into the work pane.

> <!-- SYNC-ON-DEPLOY (trident build reliability #351/#352, 2026-07-03) — flagged
> for the Managed orchestrator's SYSTEM-OVERVIEW sync. -->
> **Trident/Work Board — build reliability: worktree isolation + self-healing merge
> + interpreted failures (#351/#352, 2026-07-03).** Three Ryan-locked guarantees (no
> feature flags, one code path), fixing the verified 2026-07-03 kvwal failure where a
> pre-#342 hard-failed conflict left `.git/MERGE_HEAD` in the ONE shared
> `Projects/<proj>/code` checkout and every later build tripped "you need to resolve
> your current index first":
> 1. **Each concurrent build now merges in an ISOLATED git worktree, never the shared
>    checkout.** `trident/merge.ts` `mergeLocal` provisions a dedicated per-run
>    worktree (`<repo>/.trident-worktrees/<slug>-<id8>`, detached at base — recorded
>    in `code_trident_runs.worktree`, `runWorktreePath`, was ALWAYS empty) and runs
>    the whole rebase + #342 conflict-resolution THERE. The land onto base
>    (`git merge --no-ff`, serialized per `repo_path` by `withLocalMergeLock`) is the
>    only op touching the shared checkout and is conflict-free by construction (the
>    branch already contains base). The worktree is torn down on EVERY terminal path
>    (success OR escalation) via a `finally`. Net: one build's failed rebase can never
>    poison another's checkout.
> 2. **The merge path is SELF-HEALING.** Before touching the base repo, `mergeLocal`
>    runs `recoverStaleGitState` — it aborts any lingering `MERGE_HEAD` /
>    `rebase-merge` / `rebase-apply` (`git merge --abort` / `git rebase --abort`, whose
>    exit code is an accurate "was-dirty" probe) and `git reset --hard`s to a clean
>    base — so a checkout poisoned by a prior crash/build heals automatically instead
>    of stranding every future build.
> 3. **A failed build is INTERPRETED, never a raw error paste.** The terminal-failure
>    announce (`trident/delivery.ts` `interpretFailure`, a deterministic classifier)
>    maps `failure_reason` to a plain-language summary + the SPECIFIC input needed
>    (`merge-conflict` surfaces the #342 question; `merge-mechanics` DISCARDS raw git
>    stderr; `review-unresolved` / `hang` / `stale-state` / `infra` / `underspecified`
>    each get a human sentence + a retry/review action). Recoverable classes are
>    already auto-recovered upstream (stale state → recovery above; content conflict →
>    the #342 Forge resolver), so a run reaching the announce is genuinely unrecoverable.
> Verified by a REAL-git integration test (`trident/merge-realgit.test.ts`, temp repos
> via `spawnCapture`, NOT the mocked `RunHostCommand` that let this bug ship): 3
> concurrent builds each in their own worktree all land + base repo clean; a
> `MERGE_HEAD`-poisoned repo auto-heals; an unrecoverable conflict escalates a plain
> question AND leaves the shared checkout untouched so later builds still succeed.

> <!-- SYNC-ON-DEPLOY (M1 UX REDESIGN PR-3, 2026-07-02) — flagged for the Managed
> orchestrator's SYSTEM-OVERVIEW sync. -->
> **M1 UX REDESIGN — rail + seated tabs + ⚛ branding (PR-3, 2026-07-02).** The web
> chat shell's left rail and tab band are reskinned to the Ryan-signed-off design
> (no feature flags, one code path — the old rail-row + underline-tab CSS deleted):
> 1. **⚛ Neutron branding header.** The rail's old "PROJECTS" caps label is replaced
>    by an inline-SVG atom mark (`--accent`-lit, 3 rotated ellipses + a center dot)
>    + the "Neutron" wordmark; the new-project affordance is the `+` on the right of
>    the header (`.car-rail-newp`, toggling the inline create form — the old bottom
>    "Create Project" button is gone). (`ChatApp.tsx` `TopicRail`/`AtomMark`.)
> 2. **Telegram-style 2-line rail rows.** Each row (`RailItem`) is now an emoji
>    "avatar" (40px, plain glyph) carrying a corner **work-activity dot** (from PR-1's
>    `activity`: `working` → pulsing building-blue (`--phase-build-fg`, matching the
>    Work-list building dot — UX BATCH-2 #335), `attention` → static `--attention`,
>    else none; General never shows one), a line 1 of name + right-aligned timestamp
>    (`formatRailTime` from `last_activity_at`: today → `14:32`, this week → `Mon`,
>    else → `Jun 28`), and a line 2 of the ellipsised `preview` (own messages prefixed
>    `You:` when `preview_from==='user'`) + the unread badge. New tokens `--work`,
>    `--attention`, `--fg-2`, `--faint` in both `chat-react.html` palettes.
> 3. **Narrow (<1200px) icon rail.** A JS `narrow` render branch (`useMediaQuery`)
>    collapses the rail to a 68px icon rail — avatar + corner dot + a small corner
>    count badge, names in the row `title` — supporting PR-4's rail auto-collapse.
> 4. **Seated tabs + workspace-identity seat.** The tab band is a `--surface` strip
>    whose ACTIVE tab lifts onto the content sheet (bg = `--bg`, a border minus its
>    bottom edge, `margin-bottom:-1px` fusing it to the page); the sliding
>    `--accent` underline is DELETED. Left of the tabs sits a `WorkspaceSeat`
>    (`ProjectShell`) — the active scope's `emoji + name` (General → `💬 General`),
>    a clean "you're inside a workspace" anchor with NO activity dot (that lives on
>    the rail — Ryan's de-dup). Both palettes preserved.

> <!-- SYNC-ON-DEPLOY (UX BATCH-2, 2026-07-03) — flagged for the Managed
> orchestrator's SYSTEM-OVERVIEW sync. -->
> **UX BATCH-2 — chat/work-board polish (2026-07-03, #333/#335/#336/#338/#341).**
> Five presentational/run-progress fixes, no feature flags: (#335) the rail
> `working` dot pulses in the **building blue** (`--phase-build-fg` /
> `PHASE.build.fg`), matching the Work-list building dot exactly — web + mobile
> `ProjectRail`; amber `--attention` is reserved for a genuine stall/failed-not-done.
> (#333) the transient cold-start "⏳ Waking up…" ack is **live-only**: it rides a
> first-class `system_notice:true` flag (`AgentMessageOutbound` → adapter_options →
> `AppWsAdapter.send`), fanned to the live socket but NEVER written to the durable
> `chat_log`, so a reload can't re-hydrate it as a chat bubble. (#336) a **Fixing**
> Work item shows the fix-round (round ≥ 2), derived off `inner_checkpoint` in
> `deriveRunProgress` (the outer `code_trident_runs.round` stays 1 all build). (#338)
> chat bubbles carry a subtle **timestamp** (`HH:MM`, full date on hover) + a centered
> **day divider** ("Today / Yesterday / Mon Jul 1") on each calendar-day change
> (`RenderMessage.timestampMs` + `buildMetaIndex`; `.car-time`/`.car-day-divider`).
> (#341) the Work-item drag handle is **borderless grip-dots** (⠿, muted, grab
> cursor) — no longer a bordered button next to ▶/✕.

> **M1 UX REDESIGN — Work slide-out pane (PR-4, 2026-07-02).** On **desktop
> (≥1024px)** the Work board is **no longer a tab** — it's a right-edge **slide-out
> pane INSIDE the chat** (`PlansPane.tsx`), wrapping the shipped PR-2 `WorkBoardTab`
> body (rows unchanged). `ProjectShell` drops the `workboard` tab descriptor from
> the seated tab bar at ≥1024px (`useMediaQuery('(min-width:1024px)')`) and mounts
> the pane instead. **Below 1024px Work stays a tab** (the mobile Work badge is
> PR-6) — one implementation per viewport, never a dual tab-and-pane path.
> - **Edge-handle is the ONLY manual control.** A thin vertical grab-handle
>   (`.car-plans-handle`, a real `<button>` with an aria-label "Show work"/"Hide
>   work") rides the pane's left seam — no toggle button, no X, no close chevron
>   anywhere (Ryan's sign-off overrode the design doc's toggle-chip). Click/Enter
>   toggles it.
> - **Auto-open / auto-close is the PRIMARY behavior.** The pane slides open by
>   itself when a plan is kicked off (a board item gains a live non-terminal run →
>   the `WorkBoardTab` `onSummary` roll-up's `running` rises) and slides closed by
>   itself ~5s after ALL runs finish (running + failed both zero). A **failed run
>   keeps it open** (attention). A manual handle toggle overrides + persists
>   per-project (`localStorage`) until the next auto-kickoff. State machine:
>   `usePlansPaneController`.
> - **Floating panel, not a wall.** The chat STAGE below the band is a 2-column CSS
>   grid (`.car-stage`) whose pane column animates `0 → --pane-width` (340px), so
>   the chat column shrinks in lock-step (chat is never overlaid). The panel itself
>   floats flush to the right edge with top/bottom breathing room (~16px), rounded
>   left corners, and a soft shadow — it reads as a panel that slid in next to the
>   chat. Motion is `--ease-out` (no bounce), gated by `prefers-reduced-motion`.
>   Both palettes preserved.

> **Light/dark theme toggle (2026-07-01).** The web chat is CSS-variable-driven:
> `chat-react.html`'s stylesheet has ONE dark `:root` var set (the historical
> default) and a `:root[data-theme="light"]` override set with an
> iMessage-on-iPhone light palette (white surface, `#007AFF` user bubble,
> `~#E9E9EB` grey agent bubbles with near-black text, iOS separators). EVERY
> color resolves through a var — there are no dark-only leftovers — so flipping
> `data-theme` reskins the whole UI with no dual code path and NO feature flag (a
> theme is a user preference, not a code-path flag). Resolution is the single
> source of truth in `landing/chat-react/theme.ts` (`resolveTheme(pref,
> systemPrefersLight)`): an explicit `light`/`dark` preference wins; `system`
> (the DEFAULT, and anything unrecognized) follows `prefers-color-scheme`. The
> preference persists in `localStorage['neutron-theme']`. Two appliers mirror
> that module: a tiny pre-paint inline `<script>` in `chat-react.html` sets
> `data-theme` (+ the `theme-color` meta) BEFORE the stylesheet paints (no dark
> FOUC), and the React `useTheme` hook re-applies + owns it after mount,
> subscribing to `prefers-color-scheme` while the preference is `system`. The
> top-right `ThemeToggle` (in `ProjectShell`'s `.car-topbar`) cycles system →
> light → dark, showing the resolved glyph (☀/☾) with an "Auto" marker while
> following the OS.

> **Doc references are tappable in-app (P-A).** The live agent announces a doc it
> drafts/edits with the marker `[friendly-name](docs:/<project_id>/<path>)`
> (instructed in `build-live-agent-turn.ts`'s `<live_agent_context>`), which the
> app-ws adapter rewrites — for a `platform=web` client — to the web doc-link URL
> `/projects/<id>/docs?path=…` (`runtime/doc-links.ts`). Tapping that link in
> chat does NOT open a new tab: `Markdown.tsx` recognises the href
> (`doc-link-nav.ts` `parseWebDocLinkHref`) and, via `onDocLink` threaded
> `ProjectShell → ChatApp` `DocLinkContext` → `TextPart`, switches to the
> Documents tab and opens that doc (`DocumentsTab` `openRequest`). Cross-project
> links `controller.setProject(...)` first. Mobile native resolves `neutron://`
> doc links via `app/lib/doc-links.ts`.
>
> **A RAW doc-link href still opens in-app (#376).** `rehype-sanitize` strips a
> `docs:`/`neutron:` scheme href BEFORE any click handler can read it, so a chat
> bubble that carries the un-rewritten canonical marker `docs:/<id>/<path>` or the
> native `neutron://docs/<id>/<path>` shape used to render a DEAD link (no `href`
> → a tap did nothing). The app-ws adapter rewrites LIVE web pushes to the web
> shape, but the RESUME replay (`appChatRowToEnvelope`) re-emits the persisted
> body verbatim, and that body is channel-baked at send time — so a non-web-baked
> doc-link reaches the web client raw. `Markdown.tsx` now runs a rehype plugin
> (`rehypeWebifyDocLinks`, `doc-link-nav.ts` `webifyDocLinkHref`) BEFORE sanitize
> that normalizes both raw shapes to the same-origin `/projects/<id>/docs?path=…`
> URL, so the href survives sanitize and the existing tap-interception (and the
> SPA-boot handler) open it in the Documents tab. External URLs are untouched.
>
> **Doc links are also REAL navigable URLs (deep-link 404 fix).** A HARD load /
> new-tab / shared `/projects/<id>/docs?path=…` URL used to 404 — nothing served
> the SPA shell for any path but the exact `/chat`. Now a `GET /projects[/…]`
> browser navigation (`landing/spa-routes.ts` `isSpaClientRoute`) is a SPA
> catch-all: it serves the same chat-react shell. Two seams make it work: (1)
> **routing** — `gateway/http/compose.ts` (and the raw `landing/server.ts` fetch,
> the Open single-owner path) delegate the `/projects[/…]` GET to the shell
> instead of the default 404; the match is a prefix disjoint from every
> API/asset/operator path so it can NEVER mask a real `/api/*` 404 (an unknown
> `/api/app/…` still 404s). (2) **boot-open** — the Open `openFetch`
> (`open/composer.ts`) gives the deep link the SAME owner cookie-mint +
> `__neutron_*` bootstrap injection as `/chat` (a fresh no-cookie visit 302s to
> the SAME path with the owner cookie, preserving the doc path), and
> `chat-react/config.ts` parses `window.location` into `config.initialDocLink`
> (`doc-link-nav.ts` `initialDocLinkFromLocation`) so `ProjectShell` opens the
> doc once on boot via the same `onOpenDocLink` the tap uses. `Markdown.tsx`
> keeps `target="_blank"` (a middle/cmd-click still opens a real, now-navigable
> URL). On Managed the deep link is gated like `/chat` (`isGatedUserFacingRoute`)
> AND `landing/auth-gate.ts` mints a fresh `?start=` for a cookie-valid returning
> user — redirecting to the SAME path with `?start=<fresh>` appended (path
> preserved) so the Managed shell (identity from the JWT `sub`, no Open `__neutron_*`
> injection) boots identified instead of throwing `ChatBootstrapError`.

> **STATUS.md leads the Documents list (P-B).** The standard per-project
> `STATUS.md` lives at the PROJECT ROOT (`Projects/<id>/STATUS.md`), a sibling of
> `docs/` — outside the docs root the surface is otherwise confined to. `DocStore`
> (`gateway/http/doc-store.ts`) surfaces it as a top-level tree entry LEADING the
> tree and routes read/write/stat for the exact top-level path `STATUS.md` to the
> project root (`ROOT_SURFACED_DOCS`, a tight single-basename exception; a real
> `docs/STATUS.md` wins). The web client also pins a top-level STATUS.md first in
> `flattenDocFiles` (`PINNED_DOC_PATHS`).

> **Onboarding/chat parity fixes (2026-06-27).** Six React-client regressions vs
> the old vanilla chat were fixed: (1) a fresh onboarding auto-starts — the
> server pushes the first prompt on connect and the client shows a "Setting
> things up…" loader (server flag `window.__neutron_onboarding_active` →
> `BootstrapConfig.onboardingActive`) instead of "Send a message to begin.";
> (2) tighter bubbles (`min-width:4ch`, 8/13 padding); (3) quick-reply buttons
> render the real choice text (`opt.body`), not the A/B/C letter `label`;
> (4) ChatGPT/Claude export ZIP upload is CHUNKED (`uploads.ts`
> `importHistoryZip` drives the shared `upload-client.ts` `uploadChunked`:
> `POST /api/upload/<source>/start` → per-chunk 4 MiB `PATCH` → terminal
> completion, mounted in prod at `open/composer.ts`) with a live upload
> progress bar in the import UI (`ChatApp.tsx` `ImportStatus`, distinct from
> the post-upload analysis progress) — a large export no longer 413s on a
> single giant body; the terminal chunk kicks the SAME `notifyImportUpload`
> engine advance the old single-shot POST did; (5) iMessage-style — reaction "＋" and
> Edit/Delete are hover-revealed, not always-on; (7) no spurious empty agent
> bubble above the typing indicator (`controller.ts` drops the empty-delta open
> frame; the typing dots key off `awaitingFirstToken`).

> **Onboarding runs AS the live CC session (BUG 0, Path 1, 2026-06-27).** The
> deeper rearchitecture shipped: onboarding is no longer a per-turn phase machine
> / LLM router — it runs in the SAME live Claude Code session as steady-state
> chat. While the owner isn't onboarded the live session's first turn carries an
> `<onboarding>` system preamble and Claude conducts the interview
> conversationally; a fire-and-forget **post-turn extractor**
> (`onboarding/interview/post-turn-extractor.ts`, substrate-backed) scribes
> name/projects/interests/personality into `OnboardingStateStore.phase_state`.
> (Onboarding never asks for an AGENT name — Open is an orchestrator, not a named
> personal agent; DROP the agent-NAME step, 2026-07-01.) When the 4 required
> fields complete, `build-onboarding-finalize.ts` composes +
> commits the persona, materializes the named projects (rows + topics + docs +
> MEMORY/gbrain), and marks the row completed → next turn is plain chat in the
> SAME session. History import stays full-fidelity (engine-driven synthesis +
> `import-running-cron` write the DOCUMENTS; an import-completion watcher
> auto-consumes `import_analysis_presented` and the completion path materializes
> MEMORY/gbrain — no accept button). **The import RUNS in Path-1 (ND2, 2026-06-28):**
> the live-agent onboarding seam shows the 📎 zip-import affordance on every
> conversational turn (whenever an import substrate is wired), so the engine sits
> at a conversational phase (`work_interview_gap_fill`, …), never the legacy
> `import_upload_pending`. `notifyImportUpload` therefore treats a zip uploaded
> through that affordance as SOLICITED — in `open` mode with `importJobRunner`
> wired (the exact condition under which the affordance is offered) and no job
> already in flight, it calls `startImportAndAdvanceToRunning` instead of the old
> `no_active_prompt` 200-OK no-op that orphaned the upload. The web client
> (`ChatApp.tsx`) only renders "reading your history now" when the upload
> response carries a real `job_id`; a `job_id:null` no-op surfaces an honest
> "couldn't start the import" notice (kills the banned silent-false-success). The 6 s router that said "I didn't quite
> catch that" is gone by construction; `NEUTRON_ONBOARDING_CONVERSATIONAL` is
> collapsed (one path, no flag). Supersedes the deferred-BUG-0 note and
> `docs/research/p2-v3-conversational-onboarding-design.md`.
>
> **Projects are gated on import completion (SEV1 M1, 2026-07-01).** Onboarding
> must NOT create projects from thin chat answers while a history import is still
> uploading/analyzing — the real project signal is the import. Three aligned
> gates enforce this: (1) `probeInFlightImport` (open/composer.ts) now also
> reports an in-progress **chunked upload** (`upload_sessions.status='uploading'`,
> not just a live `import_jobs` row) so the whole client→server upload window
> counts as "import in flight" — closing the hole where a turn settling the last
> field mid-upload finalized before the `import_jobs` row even existed; (2) the
> post-turn extractor drops the project-discovery fields (`primary_projects`,
> `non_work_interests`, `dropped_projects`) from its `phase_state` write while an
> import is in flight, so thin chat answers can't accumulate (import-INDEPENDENT
> `user_first_name`/`agent_personality` still land, so the interview keeps
> progressing); (3) a per-turn `<import_in_flight>` preamble fragment
> (`onboarding-preamble.ts`) steers the live agent to skip project questions
> during the upload and settle personality/voice instead. `finalizeImport
> OnboardingIfReady` also treats `import_upload_pending` as a blocked phase.
> Project discovery resumes the moment the import lands + is consumed (or was
> never gated when the owner has no import).
>
> **No-context projects: honest opening + minimal STATUS (SEV1 M1, 2026-07-01).**
> "Better nothing than a bad job." The materializer
> (`onboarding/wow-moment/project-materializer.ts`) computes `has_context` =
> matched transcript slices OR import/project-derived context
> (`hasRealProjectContext`). A NO-context project (thin chat answer, no import
> match, no related signal) gets a MINIMAL `STATUS.md` — clean frontmatter,
> `one_liner:""`, one body line "Created during onboarding - no context yet." — and
> NO `autonomous_overnight_enabled`, NO `## Autonomous Overnight Work` section, NO
> seeded "Deepen + analyze from imported context" overnight task, and NO
> `docs/overnight/seed-context.md` (all of which would queue phantom overnight
> work against zero data). Its opening (`emitProjectOpenings` →
> `buildNoContextProjectOpening`) asks for context directly ("I don't have any
> context on X yet - tell me a bit about it, and what do you want to work on
> first?") instead of fabricating a "here's where X stands ... active, P2"
> summary. A project WITH real context keeps the full STATUS + overnight opt-in +
> real summary opening. A no-context HOBBY still gets the kickoff's engaging
> questions (its own meaty opening).
>
> **Per-project isolated onboarding compose (#377/#378, Approach A, 2026-07-20).**
> Each project's onboarding docs (README / `docs/transcript-summary.md` — the docs
> the openings later READ), its agentic-kickoff `starting-plan.md`, and its opening
> chat MESSAGE are all composed in a PER-PROJECT ISOLATED compose session, NOT the
> shared owner-wide `cc-llm-*` phase-spec session that used to back them. The
> composers (`build-project-doc-composer.ts`, `build-project-kickoff-composer.ts`)
> resolve their `AnthropicMessagesClient` through a `clientForProject(project_id)`
> factory (`open/composer.ts` `composeClientForProject`) that binds a fresh
> `cc-compose-*` substrate (`open/wiring/substrates.ts` `makeComposeSubstrate`) with
> `projectIdResolver: () => project_id`. Because the warm-pool key folds that
> per-turn project id (S3 §2), every project keys a DISTINCT REPL/transcript → no
> cross-project content bleed (#378, closed at the SOURCE — the doc materializer —
> as well as at the openings). The `cc-compose-*` instance id is a DISTINCT pool key
> from the live-chat `cc-agent-*` session, so composing an opening can never
> evict/terminate the owner's in-flight live-chat turn; it is TOOLLESS (no
> `enableToolBridge`, `PROFILE_ISOLATED_COMPOSE`) so untrusted project-doc-derived
> input has no tool surface; and it wires NONE of the owner-facing notice/delivery
> sinks, so compose text/banners never post to the owner's chat. The opening MESSAGE
> is now FULLY LLM-composed + unique per project (#377) — the hardcoded lead
> scaffolds ("I took a first pass at X and drafted a starting plan" / "I did a
> little digging on X") are gone; `build-project-kickoff-composer.ts`'s
> `opening_message` kind writes the bubble, and the kickoff appends the tappable
> `docs:/` link.
>
> **Post-onboarding claim redirect (Managed overlay, 2026-07-01).** At the
> terminal `completed` transition `build-onboarding-finalize.ts` fires a one-shot
> `emitOnboardingCompleted(user_id)` dep (right after `emitProjectsChanged`,
> guarded exactly-once by the finalizer's idempotency gate). In `open/composer.ts`
> that fans a payload-free `onboarding_completed` app-ws frame
> (`AppWsOutboundOnboardingCompleted`) to the owner's base + per-project topics.
> The web client (`controller.ts`) redirects the browser to a configured claim URL
> on that frame — **but only if** `NEUTRON_POST_ONBOARDING_CLAIM_URL` was injected
> into the page bootstrap (`composer.ts` `claimBootstrapScript` →
> `window.__neutron_post_onboarding_claim_url` → `BootstrapConfig.postOnboardingClaimUrl`).
> This is a Managed-overlay CONFIG, **not a feature flag**: ONE code path
> (redirect-if-URL-present); the Managed overlay points the env at the control-plane
> `/claim`, Open self-host leaves it unset so the client no-ops and onboarding
> completes normally. The redirect target lives in the client config, never on the
> frame; a `claimRedirected` latch makes it at-most-once. **Reconnect recovery:**
> the live frame is dropped if finalize fires with no socket registered (e.g. a
> background import-completion watcher finalizes while the tab is closed), so
> `on_session_open`'s steady-state branch replays it to the connecting topic for
> a completed owner when the claim URL is configured — deriving the redirect from
> the persisted `completed` state so it can't be permanently missed. Pairs with the
> neutron-managed personal-URL claim flow (`GET/POST /claim` → rename → 302 to the
> owner's personal URL).
>
> **Import advances out of `import_running` on the app-socket (ND-A, 2026-06-28).**
> Because Path-1 onboarding runs AS the live session it never calls `engine.start`,
> so it never stamps `phase_state.signup_via`. The 5 s `import-running-cron`'s
> `pollImportRunningTick` (`engine.ts`) previously HARD-REQUIRED
> `signup_via ∈ {telegram,web}` to resolve the channel; absent it returned
> `missing_channel_context` every tick and the instance was **stranded at
> `import_running` forever** — projects never registered, memory never
> materialized. In single-owner Open the channel is ALWAYS the app-socket, so the
> tick now only requires `topic_id` + `user_id`; `channel_kind` routes every
> non-`telegram` value (incl. absent / `web`) to `app-socket` (an explicit
> `telegram` signup still routes to telegram, so the engine-driven button flows
> are unchanged). Belt-and-suspenders: the Path-1 post-turn extractor also stamps
> `signup_via='web'` onto its first real extraction write when absent, so the
> invariant holds on disk too. Root-caused in
> `docs/research/fullpipe-e2e-2026-06-28.md` § Stage 3.
>
> **Import is offered FIRST + explicitly (M1 live-test, 2026-06-29).** Path-1
> onboarding is prompt-driven (the engine runs only the import subsystem), so the
> import offer's ordering lives entirely in the `<onboarding>` preamble
> (`onboarding/interview/onboarding-preamble.ts`). The offer used to sit after all
> five learning goals + was gated "after you have their name AND a sense of their
> work", so the model deferred it past the work-interview ("import is buried").
> It now renders between goal #1 (name) and goal #2 (work) and is reworded to an
> EXPLICIT, prominent ask made RIGHT AFTER the name and BEFORE the work questions —
> matching the onboarding-experience spec (upload precedes the informed interview)
> and the always-on 📎 drop-zone affordance. No new phase/modal: a pure preamble
> reposition (Option A, in-chat).
>
> **Import analysis → curation handoff (M1 live-test, 2026-06-29).** The
> import-analysis RESULT (the proposed-projects list) was delivered to the client
> but NOT threaded into the live-agent's context, so when the owner replied to
> curate it ("drop the Family Home project"), the agent answered "this is our
> first conversation, I haven't proposed any projects." Root cause: the analysis
> "wow moment" is delivered OUT OF BAND (an ephemeral app-ws `agent_message` that
> never enters the warm REPL transcript), and the onboarding `systemPreamble` is
> static + only spliced on the cold first turn — so nothing re-grounded the warm
> session on what it proposed. The fix threads it back in: (1) a new per-turn
> seam method `LiveAgentOnboardingSeam.onboardingContext(user_id)` reads the
> durable `phase_state.import_result` and emits an `<import_analysis>` fragment
> (proposed projects + rationale + which were dropped), re-injected on EVERY
> onboarding turn (warm AND cold) exactly like the Work Board block; (2) the
> Path-1 post-turn extractor now implements the `removed_projects` channel
> (already in `ExtractedFields` since GAP1) — an explicit "drop X" subtracts X
> from `primary_projects` AND records it under `phase_state.dropped_projects`;
> (3) finalize's `resolveProjects` excludes `dropped_projects` from BOTH union
> sources (the import side re-pulls `proposed_projects`, so subtracting from
> `primary_projects` alone wasn't enough), so a dropped project is never
> materialized and persona-gen (reads `primary_projects`) agrees. Mirrors the
> legacy engine's `(prior ∪ adds) MINUS removals`.
>
> **Import-delivered analysis ordering (M1 live-test, 2026-06-29).** The
> successful `import_analysis_presented` body was fanned via the ephemeral
> `emitOnboardingPrompt` (no chat_log `seq`), so the chat-core display sort
> (`compareForDisplay`, "seq-less sorts to the tail") pinned it BELOW any later
> real-seq user message — newest-at-bottom broken, and it vanished on resume.
> That specific buttonless "wow moment" message now persists through the durable
> app-ws adapter (chat_log → monotonic `seq`, replayable), so it orders with live
> chat. Every OTHER onboarding prompt (failure / rate-limit / resume — real
> buttons) stays ephemeral (the engine owns their reconnect re-emit); safe from
> double-render because `on_session_open` never re-sends the body and the watcher
> resolves the phase so the reconnect re-emit won't re-fire it.
>
> **Import-running status-bubble ordering (M1 verify, 2026-06-30).** The same
> seq-less-sorts-to-tail seam hit the "Reading through your export now…" progress
> bubble (the `import_running` `status` prompt): fanned ephemerally it pinned to
> the chat BOTTOM and stayed there after the import completed and the analysis +
> later turns arrived. Fix (`open/composer.ts`
> `resolveImportRunningStatusDelivery`, pure + unit-tested): persist the FIRST
> status bubble through the durable adapter (chat_log `seq` → chronological), and
> SUPPRESS the engine cron's re-emits (`import_running_attempt_count > 1`) so they
> don't stack duplicate durable bubbles — the live `import_progress` banner covers
> ongoing progress and the durable analysis body lands after on completion. Only
> the plain buttonless `status` bubble is persisted/suppressed; failure /
> rate-limit / resume prompts (real buttons) stay ephemeral.
>
> **Proposed-set reconciliation — finalized = displayed (M1 verify, 2026-06-30).**
> The presentation caps the proposal at `MAX_ANALYSIS_PROJECTS` (7), but Pass-2 /
> synthesis only caps as a prompt instruction (NOT enforced in code), so a >7
> synthesis stamped the FULL list into `phase_state.import_result` AND merged all
> N names into `primary_projects` — locking in projects the user never saw nor
> could drop (the agent's `onboardingContext` seam, persona-gen, and finalize all
> read the uncapped list). Fix: `capProposedProjects` (single source of truth,
> `phase-prompts.ts`) is applied at the engine STAMP chokepoint
> (`advanceFromImportRunningOnComplete` caps both `import_result` and the
> `primary_projects` merge), so the per-turn seam + persona-gen + finalize all see
> ≤7; the presentation slice uses the same helper. `resolveProjects` caps the
> IMPORT contribution to the displayed set as a finalize-layer guard but TRUSTS
> `primary_projects` verbatim (it carries only displayed names + the owner's
> explicit conversational adds, since the engine merge is capped) — it does NOT
> filter primary against the overflow, which would wrongly drop an explicit add
> whose name collides with an unshown overflow proposal (Codex P2). GAP1
> "no-narrowing" invariant (present every proposed project the user could confirm)
> is preserved.

> **Onboarding live-path content fixes — archetypes, option buttons, closing +
> per-project openings (2026-06-30).** Five Path-1 onboarding regressions Ryan hit
> live-testing, all wired INTO the live CC session (no phase-machine revival, no
> flags):
> - **Defined archetypes (item 1).** `onboarding-preamble.ts` no longer tells the
>   model to "offer a couple of concrete flavors" (which it improvised
>   inconsistently). It injects the DEFINED named-character set
>   (`STATIC_PERSONALITY_CHARACTER_FALLBACK` from
>   `personality-character-suggester.ts` — Sherlock / Marcus Aurelius / Miyagi /
>   Yoda / Atticus) at the personality step and offers THOSE.
> - **Option buttons (item 2).** The live onboarding turn used to emit
>   `options: []` always, so the React client (which already renders an
>   `agent_message`'s `options[]` as buttons + routes a tap back via
>   `on_button_choice → user_text = option.value`) never got any. The preamble now
>   instructs the agent to append a `[[OPTIONS]] … [[/OPTIONS]]` block on choice
>   steps; `build-live-agent-turn.ts:extractAgentOptions` parses it out of the
>   collected reply ON ONBOARDING TURNS ONLY, strips it from the body, and emits
>   the lines as buttons (label legend + display body + a routing `value` that is
>   the line text, byte-capped to the wire budget). `allow_freeform` stays true.
>   Server-side structured-choice detection — NOT a tool-surface change (the warm
>   REPL `--tools` allow-list must stay constant per the reuse guard).
> - **Custom-name capture (item 3).** The preamble mandates accepting ANY typed
>   name verbatim and never re-asking a name already given (the "Ferin got
>   re-asked" regression); name suggestions are offered as `[[OPTIONS]]`.
> - **Closing handoff (item 6).** `build-onboarding-finalize.ts` previously emitted
>   NO closing — the interview went silent after the last answer. It now takes an
>   `emitChatMessage` dep (wired in `open/composer.ts` to the SAME durable-history
>   + live-fan path a live-agent reply uses: a `button_prompts` row on
>   `app:<user>[:<project>]` that `chat_history_surface` hydrates + a
>   `buildAppWsSendReply` socket push) and, AFTER `emitProjectsChanged`, emits a
>   deterministic General closing pointing at the populated left rail ("open one to
>   find its Work, Documents, and Chat" — "Work", not "Work Board").
> - **Per-project opening (item 7).** Finalize now seeds each materialized
>   project's chat with a content-aware opening (summary + ONE next move) composed
>   by the SAME deterministic composer the legacy handoff used
>   (`build-onboarding-handoff.ts:buildDeterministicProjectOpening`, reading the
>   materialized `STATUS.md`/`README.md`), delivered into the project's app-ws
>   topic `app:<user>:<project>` (the key the live-agent reply path + the client's
>   per-project chat read from). SIBLING-PR COORDINATION: the web-client PR is
>   making the client read per-project topics; the opening lands on the project's
>   canonical app-ws topic, reconciled at merge.

> **Finalize message sequence + progress signal (2026-07-18).** The finalize
> message order is now **STARTING → per-project openings (bounded-concurrent) →
> CLOSING**, all through the one `emitChatMessage` seam
> (`onboarding/openings/finalize.ts`). THE BUG (live, Ryan's install): each opening
> is an LLM compose and they ran strictly serially, so with 9 projects they
> trickled into the rail over SEVERAL MINUTES with no explanation and the one
> message that says what to do next — the closing — arrived dead last ("its unclear
> what im supposed to do next"). Three changes:
> - **STARTING message** (`ONBOARDING_STARTING_MESSAGE`, dedupe_key
>   `onboarding_starting`) is emitted into the General topic BEFORE persona
>   compose / materialization / the opening composes — the earliest point at which
>   finalize commits to side effects. It fires only when `emitChatMessage` is wired
>   AND `resolveProjects(...)` is non-empty, so the zero-project path never promises
>   projects. Its own stable dedupe_key means a re-entered finalize (deferred-CAS
>   retry, boot recovery) can never show it twice.
> - **Closing copy** now names BOTH post-onboarding affordances: click into each
>   project in the left rail, AND ask general questions right here in the General
>   chat. The `..._NO_PROJECTS` variant is unchanged (no rail claim when no rail).
> - **Openings run through a bounded worker pool** (`OPENING_COMPOSE_CONCURRENCY = 3`)
>   instead of a serial `await` per project. They are mutually independent (each
>   targets its own project topic and reads only its own docs), per-project error
>   isolation is unchanged, and the pool is bounded so a large import cannot fan N
>   simultaneous substrate sessions.
>
> Also fixed in the same pass: `onboarding_state.persona_files_committed` sat at
> its schema DEFAULT 0 forever on Path 1 (verified live: the persona files existed
> on disk while the column read 0). Nothing ever wrote it — `commitPersona` writes
> the files + invalidates the loader but persists nothing, and the terminal CAS
> UPDATE set only phase/completed_at/wow_fired. `commitPersona` now returns whether
> it succeeded and the flag rides the SAME atomic terminal write
> (`completeIfPhaseStateMatches`), monotonically (`MAX(col, ?)`), so a later
> persona failure can never clear a genuinely committed persona.

> **Hobby projects + one-time agentic per-project kickoff (2026-07-01).** Two
> onboarding-end upgrades to what a fresh install produces, both landing in
> `build-onboarding-finalize.ts`:
> - **Hobbies materialize as projects.** The interview's outside-work
>   interest/hobby answers land in a SEPARATE field (`phase_state.non_work_interests`
>   + `import_result.inferred_interests`) that `resolveProjects` never read, so they
>   fed persona-gen (USER/SOUL.md) but never a `projects` row / on-disk repo. A new
>   `collectInterestProjects` adds them as a THIRD union source (after the
>   import-proposed and interview-named work projects), mapped to
>   `CapturedProject{name, rationale?, is_interest:true}`. The materializer is
>   source-agnostic, so a hobby gets the identical on-disk repo + doc set; the
>   `is_interest` flag only steers the kickoff. Existing `seen`/`dropped` dedup makes
>   the superset safe (a work project of the same name wins; a curation-dropped
>   hobby is excluded).
> - **The per-project opening is agentic when there's signal.** Instead of always
>   emitting the deterministic "want me to X?" one-liner, `emitProjectOpenings` first
>   asks a ONE-TIME `ProjectKickoff` (`build-project-kickoff.ts`) behind a HARD
>   data-sufficiency gate ("better nothing than a bad job", Ryan). Best-fit action
>   per project: **draft-doc** (rich work → compose a real starting plan via the
>   CC-substrate `build-project-kickoff-composer.ts`, `writeDocIfMissing` under
>   `Projects/<id>/docs/`, present a tappable `docs:/…` link, index it to GBrain
>   recall via the same `buildProjectPageIndexer` the materializer uses);
>   **deadline-offer** (a real upcoming import deadline related to the project →
>   name it and OFFER a reminder, never auto-create; the live agent's
>   `reminders_create` handles an accept); **interest-research** (rich hobby → light
>   starting notes doc); **interest-questions** (thin hobby → engaging questions, a
>   hobby's meaty opening, never a bad artifact); or `null` (thin work) → the
>   deterministic opening. ONE-TIME by construction: the kickoff fills the SAME
>   `onboarding_opening:<project_id>` durable slot as the deterministic opening, so
>   the on-connect recovery (`ensureProjectOpeningOnEntry`) collapses onto it and
>   there is NO cadence / cooldown / on-enter refresh / setting (none of the
>   recurring wow machinery). The full wow `ActionRunner`/dispatcher is deliberately
>   NOT reused — it is a batch button-prompt path with a channel adapter + cron that
>   the one-time plain-emit finalize has no surface for; the kickoff reuses its
>   trigger/gate CONTRACT plus `ProjectDocComposer`, `runtime/doc-links.ts`, and the
>   project-page indexer.

> **Onboarding is a GENERAL-topic-only mode + cold-turn timeout self-heals
> (#136 verify gaps, 2026-06-30).** Two robustness fixes for gaps the #136
> fresh-install verify left open:
> - **Project topics never run the interview.** Onboarding was decided per-USER
>   (`isOnboardingActive`) but applied per-TOPIC, and the web client opens a fresh
>   socket per project tab. So a project tab opened while the fire-and-forget
>   finalize was still running (or after its terminal `completed` upsert raced /
>   was swallowed) seeded the generic welcome ("…what should I call you?") INTO
>   the project topic — masking the deterministic per-project opening finalize had
>   already delivered. Now onboarding is GENERAL-only: `build-live-agent-turn.ts`
>   computes `onboardingActive` only when `turn.project_id === undefined` (so a
>   project-topic turn is always steady-state — no preamble, no `[[OPTIONS]]`),
>   and `open/composer.ts` `on_session_open` fires the auto-start welcome seed
>   only for the General topic (`channel_topic_id === appWsTopicId(user)`). A
>   materialized project only EXISTS post-onboarding, so this is the correct
>   invariant, not a heuristic.
> - **A slow cold turn completes instead of hard-failing-and-persisting.** A cold
>   onboarding spawn under machine load (CC cold spawn + MCP bind + heavy
>   onboarding system prompt) routinely exceeded the persistent REPL's snappy
>   180s `DEFAULT_TURN_TIMEOUT_MS` → `FAILURE_BODY`, and the welcome seed marked
>   the topic seeded BEFORE running, so a reload replayed the persisted failure
>   forever. New additive `AgentSpec.turn_timeout_ms` (read by the persistent CC
>   adapter as `spec.turn_timeout_ms ?? turnTimeoutMs`) lets the composer raise a
>   COLD/onboarding turn's budget to `COLD_TURN_TIMEOUT_MS` (600s — raised from an
>   initial 360s; see the reliability follow-up below) on BOTH the AbortController
>   and the substrate timer; warm steady-state turns keep the tight default (a
>   wedged warm turn still fails fast). And a FAILED `seed_turn` now stays SILENT
>   (no `FAILURE_BODY` persisted to chat_log) while `on_session_open` clears the
>   per-process `seededOnboardingTopics` mark — so a reload/re-subscribe RE-FIRES
>   the welcome instead of showing a stuck error. A failed REAL user turn still
>   gets the anti-silence bubble.

> **The welcome-seed guard is DURABLE, not per-process (2026-07-18, Ryan live
> fresh install).** SUPERSEDES the `seededOnboardingTopics` mechanism described
> in the block above. The opener was emitted TWICE into the owner's General topic
> on a fresh install. The seed was gated on an in-memory per-PROCESS `Set`, but
> the opener itself is DURABLE — the live runner persists it as a `button_prompts`
> row (`gateway/wiring/build-live-agent-turn.ts`) BEFORE it sends. So every new
> process (restart, redeploy, crash, the service bounce a fresh install performs)
> started with an empty `Set`, re-seeded on top of the already-persisted opener,
> and the client hydrated BOTH. `on_session_open` now asks the durable store —
> `buttonStore.latestTurnByTopic` on the General topic, the SAME "does this topic
> already have a turn?" check `ensureProjectOpeningOnEntry` already uses for
> per-project openings — and the in-memory map is demoted to a pure SINGLE-FLIGHT
> latch for connects that race before the first row exists (two tabs). The
> failure self-heal above needs no explicit bookkeeping anymore and its
> compensating `delete(...)` is GONE: a failed seed returns before persisting
> anything, so the durable gate re-fires it on the next connect by construction.
> One guard, one code path, no flag.

> **Turn timeout is ACTIVITY-BASED, not a fixed wall clock; freezes auto-retry +
> get a Retry affordance (2026-07-01, Ryan live-test).** The `COLD_TURN_TIMEOUT_MS`
> (600s) / `DEFAULT_TURN_TIMEOUT_MS` (180s) fixed budgets above were themselves the
> next bug: a chat turn that ran a long-but-ACTIVE build (a "weave timer+tracker
> together then do full e2e testing" request) hard-failed at exactly 180s
> (`turn_failed elapsed_ms=180009 err=persistent-repl: turn timeout`) **while the
> agent was still working**, then showed the misleading "your AI connection may need
> attention in settings" dead-end. Three coordinated fixes:
> - **Inactivity watchdog (the primary fix).** `persistent-repl-substrate.ts` no
>   longer arms a fixed `setTimeout(perTurnTimeoutMs)`. It runs an interval watchdog
>   that abandons a turn ONLY after `turn_timeout_ms` with NO PTY activity —
>   `session.lastDataAt` advances on every byte the `claude` child writes (spinner
>   ticks, streamed tokens, tool output), so an actively-working turn continuously
>   resets the idle clock and runs as long as it needs. Only a GENUINELY frozen turn
>   goes silent long enough to trip. The liveness keepalive pushes `status` events
>   but does NOT touch `lastDataAt`, so an alive-but-frozen child is still correctly
>   detected as frozen. `DEFAULT_TURN_INACTIVITY_MS` is 90s; a new
>   `DEFAULT_TURN_ABSOLUTE_CEILING_MS` (45min, additive `AgentSpec.turn_absolute_
>   ceiling_ms`) is a hard backstop so a live-but-livelocked child can't run forever.
>   `AgentSpec.turn_timeout_ms` is REPURPOSED from "wall-clock budget" to "inactivity
>   window" (the substrate reads it exactly the same way; only the semantics of the
>   number changed). The composer sends the snappy 90s window for a warm turn and a
>   larger 180s window for a cold/onboarding turn (heavier initial processing); its
>   own AbortController is now a pure absolute-ceiling backstop (45min) that also
>   covers the cold-SPAWN phase, which runs before the substrate's per-turn watchdog
>   starts — that is where the cold path's "generous window" now lives (folded into
>   the same scheme; the old separate `COLD_TURN_TIMEOUT_MS` is gone).
> - **Auto-retry once, no dead-end.** On a genuine freeze the composer auto-retries
>   the turn ONCE, silently — the substrate poisons + respawns the warm REPL on a
>   timeout, so the retry lands on a clean session and the common transient case
>   self-heals with no bubble at all.
> - **Honest message + one-click Retry (never the credential text).** If the retry
>   ALSO freezes, `build-live-agent-turn.ts` sends `TIMEOUT_BODY` ("took too long …
>   tap Retry, or just send it again") + a persisted Retry button (`RETRY_TURN_VALUE`),
>   `allow_freeform` open. A tap re-runs on the last real user message for the topic
>   (`lastUserText` in-process map → recovered verbatim; VALUE_BYTE_CAP is only 37
>   bytes so the message can't ride the button value). A freeze-timeout is
>   distinguished from a real credential/connection fault (`isFreezeTimeout`): only
>   the latter keeps the actionable `FAILURE_BODY`, so a slow turn is never
>   misdiagnosed as a broken setup again.

> **Onboarding reliability — opening recovery, empty-project loader, deterministic
> archetype step, larger cold budget (#136+#138 fresh-install verify, 2026-06-30).**
> A full fresh-install walk of #136+#138 surfaced four reliability gaps; all fixed
> WITHIN Path-1 (no flags, live-session locked):
> - **Per-project opening is now a property of ENTERING a project, not a fire-once
>   finalize side effect (item 1).** `build-onboarding-finalize.ts` emits each
>   project's deterministic opening eagerly at completion, but that emit can race
>   the project-tab socket, be swallowed, or (cold-turn) be delayed — leaving the
>   `app:<user>:<project>` topic with ZERO `button_prompts` rows (DB-confirmed on
>   the live box: 6 projects, 0 project-topic rows) and the client wedged on its
>   empty state, with no reload recovery (reload only regenerated the GENERAL
>   welcome). `open/composer.ts` `on_session_open` now, on every STEADY-STATE
>   connect to a materialized PROJECT topic with no message yet, regenerates +
>   persists the SAME deterministic opening (`buildDeterministicProjectOpening`
>   over the materialized `STATUS.md`/`README.md`) via the idempotent
>   `onboardingMsgHolder.emit` (`dedupe_key: onboarding_opening:<project_id>`), so
>   it collapses onto finalize's row if that already landed and never double-posts.
>   This single mechanism makes the opening reliable AND recovers a stuck/missing
>   one on re-entry (item 4b).
> - **An empty project chat never shows the infinite onboarding loader (item 2).**
>   `chat-react/ChatApp.tsx` gated the "Setting things up…" loader on the
>   page-global `config.onboardingActive` ALONE, so opening an empty project tab
>   while onboarding (or just after) painted the loader forever. The loader now
>   requires `config.onboardingActive && vm.projectId === null` — onboarding is a
>   General-topic-only mode, so only the General topic shows it; a project topic
>   resolves to the usable "Send a message to begin." empty state.
> - **The personality archetype + name steps are DETERMINISTICALLY presented
>   (item 3).** They lived only as soft preamble prose ("offer the DEFINED set …"),
>   and the preamble also says "you do NOT need to collect these in order" — so a
>   fresh-install run showed ZERO option buttons (the agent settled them by free
>   text). New `onboarding-preamble.ts:buildOnboardingStepGuardFragment` audits the
>   durable `phase_state` and, while `agent_personality`/`agent_name` are unset,
>   HARD-REQUIRES the named-archetype / name `[[OPTIONS]]` block (never settle by
>   free text alone, never finalize without it). It is injected EVERY onboarding
>   turn via the `LiveAgentOnboardingSeam.onboardingContext` seam (joined with the
>   import-analysis grounding), so the agent cannot drift past the personality step
>   without rendering the buttons — reliable, not LLM-whim, still inside Path-1.
>   **The guard is now AUDIT-DRIVEN, with total coverage by construction
>   (2026-07-18).** It previously inspected a HARDCODED SUBSET of the required set —
>   just `import_decision` + `agent_personality` — while `auditRequiredFields`
>   required five fields. Any required field outside that subset was an UNASKABLE
>   BLOCKER, which produced a live deadlock on Ryan's fresh install: with both
>   button steps settled the guard returned `null`, so the agent got no forcing
>   instruction for the still-missing `non_work_interests` (his import analysed to
>   `topics:[]`), believed onboarding was over and went silent, while the finalize
>   gate correctly refused to complete — `phase='work_interview_gap_fill'`,
>   `completed_at=NULL`, forever. The guard now walks
>   `auditRequiredFields(...).missing` and renders one copy block per missing field
>   from `STEP_GUARD_COPY`, a `Record<RequiredField, StepGuardCopy>`; it returns
>   `null` exactly when finalize would fire. Two presentation categories:
>   `'buttons'` steps (`import_decision`, `agent_personality`) keep their existing
>   locked `[[OPTIONS]]` lists and wording verbatim; `'free_text'` steps
>   (`user_first_name`, `primary_projects`, `non_work_interests`) force the ASK in
>   plain prose and EXPLICITLY forbid an `[[OPTIONS]]` block. Conditionality is
>   respected — `import_decision` only renders when `import_offered` is true, so a
>   box with no import substrate is never asked a question it cannot honor. The two
>   `PROJECT_DISCOVERY_FIELDS` (`primary_projects`, `non_work_interests`) are
>   DEFERRED while a history import is in flight (`StepGuardCopy.deferred_during_
>   import` + the guard's `import_in_flight` option; the composer now resolves
>   `importInFlight` BEFORE building the guard so it can thread it in): forcing them
>   mid-import would contradict `buildImportInFlightSteerFragment`, which is joined
>   into the SAME prompt, and would solicit answers the extractor drops.
>   Import-INDEPENDENT steps stay forced and the deferred ones resume once the
>   import lands — deferred, never dropped.
>   **Anti-recurrence is structural:** the `Record` makes a new `RequiredField`
>   without guard copy a COMPILE-TIME error (verified: TS2741), and an
>   exhaustiveness test iterating the exported
>   `REQUIRED_FIELDS_IN_PRIORITY_ORDER` asserts every field alone yields a
>   fragment naming it. (Also corrected: the docblocks claiming finalize "triggers
>   once personality is settled" — personality is priority 5, but
>   `non_work_interests` is audited BEFORE it at priority 4, which is what made the
>   false comment mask this deadlock.)
> - **Cold-turn budget raised 360s → 600s (item 4a).** #138's 360s still hard-failed
>   a real onboarding work-question turn at ~5.5min under fleet/dogfood load; 10
>   minutes leaves comfortable headroom over the observed worst case, with the
>   seed-failure self-heal + the project-opening regeneration above covering the
>   rarer turn that exceeds even this.
> - **Name/personality settle DETERMINISTICALLY at choice-time — no double-ask; ONE
>   closing (2026-06-30, Ryan live test).** The step guard above made the archetype/
>   name buttons appear, but the two button-backed fields were still persisted ONLY
>   by the fire-and-forget post-turn LLM extractor ("agent_name — LLM only"). So a
>   TAP left `phase_state` unset until that slow/timing-out extractor caught up, and
>   the same step guard — reading STALE pre-turn `phase_state` every turn —
>   re-injected "STILL OPEN - NAME" and the agent re-asked the just-tapped answer.
>   **Fix:** a new PURE decider `onboarding/interview/button-backed-answer.ts:`
>   `captureButtonBackedRequiredField` + a new `LiveAgentOnboardingSeam.`
>   `captureRequiredAnswer` seam the live runner calls + AWAITS at turn-START
>   (BEFORE the guard grounding reads `phase_state`), persisting
>   `agent_name`/`agent_personality` deterministically so the audit recomputes
>   settled and never re-asks. Conservative: keyed off the prior question's DURABLE
>   persisted options (`ButtonStore.latestPromptByTopic` — live replies strip the
>   `[[OPTIONS]]` block out of `body`), personality anchored on the DEFINED
>   archetype names actually rendered (an early
>   import yes/no can't be mis-captured), escape hatches declined, LLM extractor
>   kept as the free-text fallback. **Duplicate closing:** when that capture settles
>   the LAST required field it fires finalize and returns `finalized: true`, and the
>   runner SUPPRESSES its own wrap-up (no dispatch, no `agent_message`) so the single
>   deterministic finalize closing (which names the LEFT RAIL) is the ONE closing;
>   the preamble also tells the agent not to write its own closing (and to avoid em
>   dashes).

> **DROP the agent-NAME step — personality-only onboarding (2026-07-01).**
> Neutron Open is an agent ORCHESTRATOR, not a named personal agent, so onboarding
> NO LONGER asks the owner to name it — it only asks for personality (→ SOUL.md).
> This SUPERSEDES the name halves of the 2026-06-30 items above. Concretely: the
> step-5 "a name for you" ask + the custom-name-acceptance copy are gone from
> `onboarding-preamble.ts`; `buildOnboardingStepGuardFragment` no longer has a
> `needsName` branch (personality is the ONLY button-driven required step and the
> guard returns null once it settles); `required-fields-audit.ts` drops
> `agent_name` from `RequiredField`/`PRIORITY` (now **4** required fields —
> `user_first_name`, `primary_projects` ≥3, `non_work_interests` ≥1,
> `agent_personality` — so finalize triggers once personality is set);
> `button-backed-answer.ts` settles only `agent_personality`; the post-turn
> extractor no longer solicits or persists `agent_name`; and `open/composer.ts` no
> longer wires the `agentNameSuggester` into onboarding. `agent-name-suggester.ts`
> stays in the tree (Managed reuses it) and the LEGACY phase-machine engine's
> `agent_name_chosen` phase is untouched (`agent_name` remains a valid `phase_state`
> key, just not audited/required). `soul.ts` already renders SOUL.md from
> personality alone ("You are a personal agent." opener when no name is present),
> so personality → SOUL.md is unaffected. NO FLAGS; done = onboarding asks
> personality but never a name, finalizes without one.

The React web client (`landing/chat-react/`) is **registry-driven** too, and
since the 2026-06-30 rework `chat-react/ProjectShell.tsx` is the **APP SHELL**:
a persistent `TopicRail` left column (lifted out of `ChatApp`) + a content pane
holding the `TabBar` over the active tab body. The tab set comes from the same
resolver — **General** (no project) fetches `GET /api/app/tabs` (Chat + Admin +
global Cores); a **project** fetches `GET /api/app/projects/<id>/tabs` (Chat /
Plan / Documents + project Cores, NO Admin) via `chat-react/tabs-client.ts`
(`WebTabsClient`, bearer-authed off `config.token`). `main.tsx` mounts
`ProjectShell` inside the `AssistantRuntimeProvider` (so the chat session
survives tab switches). Tab content: **Chat** = `ChatApp` (the chat body), kept
MOUNTED (hidden via `hidden`) across switches; **Plan** (`workboard`) +
**Documents** (builtin) = their real views; **Admin** (`mount.target==='admin'`,
General only) = the integrations surface; **Core** (`mount.kind:'webview'`) =
the Core's `project_tab` in a sandboxed `<iframe>`, URL scheme-validated
(`sanitizeCoreTabUrl`, http(s) only). The rail is always visible (General + every
project, all tabs) so a project switch — which RE-SCOPES the chat to that
project's topic (see the per-project-chat note above) — and Create-Project are
reachable from anywhere. No feature flag; an unreachable resolver degrades to the
guaranteed Chat tab. CSS lives in `chat-react.html` (`car-app` / `car-content` /
`car-rail*` / `car-tab*` / `car-md`). Tests:
`chat-react/__tests__/tabs-client.test.ts` (pure client + URL sanitize) +
`project-shell.test.tsx` (happy-dom: project view renders Chat/Plan/Documents/Core
+ the rail; General view renders Chat + Admin) + `controller.test.ts` (per-project
re-scope + transcript hydration on switch).

### Web Documents tab (WAVE 3 PR-5 + PR-6)

The builtin **Documents** tab (`mount.target === 'docs'`) renders
`chat-react/DocumentsTab.tsx` — the web Obsidian-replacement surface inside
`ProjectShell`. As of **PR-6** it is at **web↔mobile parity**: browse · open ·
read · **edit** · comment (PR-5 shipped read+comment; PR-6 added editing). It
adds **no `documents` table**: bodies stay filesystem-backed, served by the
existing gateway docs surface (`gateway/http/app-docs-surface.ts`). The tab is a
three-pane layout — structured **left nav** (Pinned→Recent→tree, PR-5) · markdown **viewer/editor** (centre) ·
**comments** side-pane (right) — over `chat-react/docs-client.ts` (`WebDocsClient`,
the web twin of `app/lib/docs-client.ts`: bearer-authed off `config.token`, base
URL `config.origin`, wire types re-declared client-side so the bundle stays
gateway-free):

- **Left nav** (M1 UX redesign PR-5) = a structured **`DocSidebar`** — top→bottom
  **Pinned → Recent → folder tree** — consuming the hierarchical `GET /docs/tree`
  **directly** (the old flat `flattenDocFiles` desktop list is **retired**; the
  helper stays exported for `docs-client.ts` unit tests). Pinned = `PINNED_DOC_PATHS`
  (STATUS.md) present in the tree; Recent = the 5 most-recently-modified docs
  (newest first, pinned excluded, `modified_at` epoch-ms via `formatDocTime`); the
  tree renders folders with standard disclosure carets (▸ closed / ▾ open, default
  expanded) + indentation — flat rows, no nested cards. Both light + dark palettes
  (`.cdoc-side` / `.cdoc-drow` / `.cdoc-seclbl` tokens in `chat-react.html`). Tests:
  `chat-react/__tests__/doc-sidebar.test.tsx`.
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

**`.html` docs render as static styled pages (2026-07-01).** The docs store +
API allowlist now accept `.html`/`.htm` alongside `.md`/`.markdown` for
read/list/open/write — the single source of truth is `DOC_EXTENSIONS` +
`isDocLeaf` in `gateway/http/doc-store.ts` (used by both the tree walker and the
`validateRelativePath` `requireMd` gate; the duplicate history/comments gate in
`app-docs-surface.ts` shares `isDocLeaf`). Before this, saving/opening an `.html`
doc failed with `invalid_extension: path must end with .md or .markdown`. In the
Documents tab, the **Rendered** view branches on extension: an `.html`/`.htm`
doc renders through `chat-react/HtmlDoc.tsx` as a **static styled HTML/CSS page**
— the doc's HTML structure + CSS (both `<style>` blocks and inline `style`) are
preserved, but **script execution is explicitly excluded**: `sanitizeHtmlDoc`
strips `<script>` (incl. SVG script), `<iframe>`/`<object>`/`<embed>`/`<base>`/
`<meta>`/`<link>`, every `on*` event-handler attribute, and `javascript:`/
`vbscript:`/`data:text/html` URLs, then the sanitized document's **live
`<documentElement>` nodes are adopted into a Shadow-DOM island** (keeping
`<html>`/`<body>` so `body{…}`/`html{…}` CSS + body attributes apply) so the
doc's CSS is scoped and can't restyle the app. A
`.md` doc keeps rendering via the Markdown path unchanged; Source view + Edit
still show/edit the raw text of either. **Interactive JS apps do NOT belong
here** — they route to the app launcher (a separate, out-of-scope surface), not
the doc renderer. Tests: `chat-react/__tests__/html-doc.test.tsx` (sanitize
strips scripts/handlers/js-URLs while keeping structure+CSS; the component
mounts into a shadow root and no doc script executes) + the `.html`/`.htm`
read/list/write round-trip in `gateway/__tests__/app-docs-surface.test.ts`.
(The mobile docs tab `app/app/projects/[id]/docs.tsx` still renders markdown
only; an `.html` doc now surfaces in its list but its static HTML render is a
follow-up.)

**Mobile docs = single-pane iOS drill-down (M1 UX redesign PR-5).** On PHONES the
docs tab is a single-pane list (`components/DocsDrillList.tsx`): screen 1 shows
**Pinned → Recent → root** files/folders; tapping a **folder** pushes the SAME
list scoped to that folder (`?folder=<rel>`), tapping a **file** pushes the
full-screen viewer/editor (`?path=<rel>`) — each a `router.push`, so the native
back gesture / hardware back walks up the stack (the iOS Files pattern; the header
breadcrumb IS the nav stack). Scoping + Pinned/Recent/time helpers are pure in
`lib/docs-drill.ts` (`scopeToFolder` / `collectPinnedNodes` / `collectRecentNodes`
/ `folderTitle` / `formatDocTime`; tests `__tests__/docs-drill.test.ts`). **Wide /
tablet (≥720px) keeps the inline two-pane** (`TreeBranch` + viewer) unchanged — the
only fork is the responsive `wideViewport` branch. The viewer/editor/comments
internals are untouched by PR-5.

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

### Tasks — a Core-contributed `app_route` tab on BOTH clients

Tasks is **not** a builtin tab (Ryan directive, 2026-06-30 — see the tab-registry
note above) and must not be re-added as one. It reaches both clients as a
**Core contribution**: the Tasks Core declares a `launcher_icon` plus an
`app_tab` whose `props_schema` fixes `path: '/projects/<project_id>/tasks'`,
`label: 'Tasks'`, `order: 30` (`cores/free/tasks/package.json` `ui_components`).
The resolver reads those consts and emits
`mount:{kind:'app_route', target:'/projects/<id>/tasks'}`, which mobile navigates
via expo-router and web renders as `TasksTab`.

The tab appears **only when the Tasks Core is installed** in the scope
(`core_installations`), and disappears when it isn't — install state is the gate,
not a hardcoded entry.

> **History (closed 2026-08-01).** For a period this contributed nothing: the
> resolver matched only `project_tab` surfaces while every bundled UI Core
> declares `app_tab`, AND `open/composer.ts` passed the resolver no
> `cores`/`installations` at all. Tasks was storable and agent-readable but
> unreachable from any tab on either client; the launcher tile was the only way
> in, and the engine-resolved tab set had dropped the launcher too.

The tasks *backend* stays live and agent-writable. The prioritized ordering is
LLM-primary (`tasks/prioritize-llm.ts`): ranked rows first by `llm_rank`, fresh
rows interleaved by `focus_score`, with `tasks/store.ts` the single source of
truth (`order=focus_score`, `#N` rank + one-line `llm_reason`). The read/write
HTTP surface is `gateway/http/app-tasks-surface.ts`; the mobile client is
`app/lib/tasks-client.ts` (bearer-authed off `config.token`). Every mutation hits
the same canonical `TaskStore` the agent's `cores/free/tasks` backend writes:
**Reprioritize** PATCHes the 0-3 `priority` field (the column the focus-score
reads), Open tasks **Cancel** (soft), already-closed rows **Delete** (hard).

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

## Per-project Settings tab + credential system (`project-credentials/`, FOUNDATION)

Each project's tab set is Chat / Plan / Documents / **Settings**. The Settings
tab is a registry builtin (`tabs/registry.ts`, `key:'settings'`, `order:15`,
`mount.target:'settings'`) — both clients (web `landing/chat-react/SettingsTab.tsx`
via `ProjectShell.tsx`'s `TabContent`; mobile `app/app/projects/[id]/settings.tsx`)
render it from the ONE engine registry, never hardcoded. It hosts the
credentials UI, project rename + **emoji edit** (a real editable control since
the rail-redesign sprint — PATCH `{ emoji }` to the settings surface, mirroring
the name rename), and a display-only, M2-gated collaborators scaffold.

**Credential model.** A credential is a static, long-lived named value set at
**per-project** or **global** scope. The owner supplies both the service name and
value, so a fresh install shows an empty list rather than product-defined empty
slots. Values are write-only: POST accepts plaintext, while POST and GET responses
carry metadata only and never render the value back.
Resolution is **per-project → global → unset** (`ProjectCredentialStore.resolve`)
so a single-owner install that only sets global tokens keeps working and a
project can override a service with its own token. Storage is a NEW table
`project_credentials` (migration `0092`, STRICT) — deliberately NOT an overload
of `secrets` (whose `project_slug` column is a decoy for the frozen instance
handle). Every row is keyed on a **composite**: `owner_slug` (the SERVER-derived
instance handle from the bearer — the owner boundary, never client-supplied) +
`project_id` (the REAL per-project id, `''` sentinel for global) + `service`.
This differs from the Work Board (which keys purely on the instance slug and
ignores the URL project id): credentials are genuinely per-project, so the real
project id is part of the key, gated underneath the server-derived owner
boundary — so no caller can read another owner's credentials. Ciphertext reuses
the `secrets` AES-256-GCM envelope (shared `.neutron-aes-key`); `list` returns
metadata only.

**Surfaces + resolver + awareness.** Bearer-gated CRUD
(`gateway/http/project-credentials-surface.ts`) owns TWO route families — one
per scope, because **the route is the scope** — wired into `open/composer.ts` →
`composition.ts` → `compose.ts` ahead of `appProjects` (mirrors work-board
precedence), both on the one `app-project-credentials` rung:

- **GLOBAL** — `/api/app/credentials[/<service>]` (GET/POST/DELETE). The only
  way to write an instance-wide default. Authored in **General → Admin**
  (`IntegrationsTab` § Shared credentials; mobile: Integrations screen).
- **PROJECT** — `/api/app/projects/<id>/credentials[/<service>]`
  (GET/POST/DELETE). Writes only that project. The GET still RETURNS the
  inherited globals so the Settings tab can show them, labelled and read-only.

The project family **cannot** write global state (ISSUES #486). It used to: a
`scope` field in the POST body and `?scope=global` on the DELETE were honoured
there, so a credential written while standing in ONE project silently changed
the default EVERY project inherits — two writers for one fact. Both now return
HTTP 400 `scope_not_allowed` rather than downgrading silently, so a stale client
surfaces an error instead of a write landing where the owner was not looking. The same canonical `ProjectCredentialStore`
backs the resolver AND the agent awareness: a per-turn `<available_services>`
DATA block (`project-credentials/fragment.ts`), keyed on the real per-turn
`project_id` (`LiveAgentTurnRequest.project_id`, parsed from the topic), spliced
by `gateway/wiring/build-live-agent-turn.ts` exactly like the Work
Board block — so the agent knows which external services it can use in THIS
project and gracefully refuses the rest, and switching projects flips
availability within one turn. Wiring the existing Cores to CALL the resolver is
a named follow-up (needs per-call `project_id` threaded into each Core's token
provider — the deferred Phase-3 Cores rework).

### Connected accounts — the per-project selection (ISSUES #500)

The Settings tab's **Connected accounts** section is the owner-facing half of the
`accountsFor` filter described under *Per-project credential resolution (D2)*. It
lists every selectable service (`google_calendar`, `gmail_compose`,
`google_workspace`) with one checkbox per connected account, each labelled by its
address — `account_id` is a SHA-256 prefix and never reaches the screen, so the
server sends a HUMANISED `label` (`humaniseAccount`) and the client renders that.
A service with every account off shows an explicit "Off for this project" line,
because off must not look like broken.

This lives on a PROJECT route while #486 moved global credential authoring OFF
project surfaces, and the two are consistent rather than in tension: #486 was
about a project surface authoring INSTANCE-WIDE state; an account selection can
only ever mean something inside one project, so the project surface is its
correct home.

- `GET /api/app/projects/<id>/accounts` → `{ project_id, services: [{ service,
  accounts: [{ account_id, label, account_email, enabled }] }] }`. Every
  selectable service is listed regardless of what is connected, so the response
  shape does not fluctuate with connection state.
- `PUT /api/app/projects/<id>/accounts` with `{ service, account_id, enabled }`
  toggles exactly one account and returns the WHOLE refreshed view, so the client
  renders from the server's truth instead of patching a local copy. PUT because
  the operation is idempotent both ways: enabling DELETES the disable row,
  disabling inserts one.

Both routes are served by `gateway/http/project-credentials-surface.ts` on the
existing `app-project-credentials` rung, bearer-gated, with `owner_slug` derived
from the bearer exactly as the credential families are. Store:
`project-credentials/account-selection-store.ts` — no secret material passes
through it. The Settings surface reads its view from the SAME
`CoreCredentialResolver` the Cores resolve against
(`accountSelectionView(projectId)`), so what the owner toggles is definitionally
what his projects sweep.

### Connect Codex — a GLOBAL credential for the trident cross-model reviewer

The trident cross-model reviewer (`trident/codex-review.sh`, Part A) needs a
ChatGPT-subscription credential. Because **trident runs across ANY project**, that
credential is **GLOBAL, not per-project**: the PRIMARY place to connect it is the
account-wide **General → Admin** tab (`IntegrationsTab`), alongside the other
global integrations. A **per-project OVERRIDE** exists for the edge case where one
project needs a different subscription — an override wins over the global default
for that project only (store resolver: **project → global → unset**, PR #149).
Codex has no headless device-flow, so the UX is: run `codex login` (ChatGPT
account) once, then paste the contents of `~/.codex/auth.json`.

- **Validation (subscription-only).** `trident/codex-auth.ts:validateCodexSubscriptionAuth`
  accepts a bundle with `tokens.access_token` + `tokens.refresh_token` and
  **REJECTS** a metered `OPENAI_API_KEY` (auth_mode=apikey) or a bare `sk-…` paste
  — Ryan's standing rule is never the metered path. The accepted bundle is
  normalized (API key stripped) before storage.
- **Storage (global by default).** Stored encrypted in the `project_credentials`
  store (service `codex`), same AES-256-GCM keyfile as every other credential.
  `connect()` defaults to `scope='global'`; a project override is `scope='project'`
  under the REAL project id.
- **Materialization.** The global default writes to the owner CODEX_HOME
  (`resolveCodexHome({ owner_home })` = `<owner_home>/.codex/auth.json`, mode 0600)
  — the SAME path the trident loop threads into the inner workflow
  (`build-core-modules.ts` reads `trident.codex_home` from the composer). A project
  override writes to a nested per-project dir
  (`codexProjectHome(globalHome, project_id)` = `<owner_home>/.codex/projects/<id>/auth.json`).
  `CodexCredentialService.resolveActiveCodexHome(owner, project_id)` is the
  trident-review resolver (project override → global → `null`) with self-healing
  re-materialization; a boot-time `ensureMaterialized` self-heals the GLOBAL file.
  The trident loop threads the global CODEX_HOME (the trident-wide default).
- **Status.** GET returns `connected` / `expired` (access-token JWT `exp` in the
  past) / `not_connected`, plus `scope` (which supplied the resolved credential —
  `project` override vs `global` default, or `null` when unset).
- **Surfaces.** HTTP `gateway/http/codex-credential-surface.ts` — the GLOBAL
  `/api/app/codex-auth` (primary) + the per-project override
  `/api/app/projects/<id>/codex-auth` (both GET/POST/DELETE) — plus agent-native
  `codex_connect` / `codex_status` tools (`trident/codex-credential-tool.ts`,
  global-scoped: the tool context carries only the owner boundary), all dispatching
  the ONE `CodexCredentialService`. The per-project override UI is in that project's
  Settings tab (`SettingsTab.tsx`), clearly labelled optional.

### Connect GitHub — the device flow, and the control that finally starts it (#551)

A build pushes a branch and opens a pull request with the OWNER's GitHub token.
The whole chain for obtaining one has been merged and composed for months —
`github/device-flow.ts` (protocol), `github/connect.ts` (order),
`github/credential.ts` (storage), `trident/git-mode.ts` (hands it to every host
command), and `gateway/http/github-connect-surface.ts` behind route slot
`app_github_connect_surface` → `/api/app/github-auth`. **No client on any surface
called it.** The backend tests passed, the route resolved, and a
composition-coverage test asserted the slot was mounted; none of them asked
whether a human could start the flow. So the only path to a token was a shell on
the machine, which is what the agent recommended when a push failed — see
`MISSING_CREDENTIAL_DOCTRINE` above, the other half of the same fix.

- **The surface (unchanged).** `GET` reports `connected` |
  `awaiting_owner` (with `user_code`, `verification_uri`, `expires_in_seconds`) |
  `not_connected`. `POST` starts a flow and answers IMMEDIATELY with the code,
  polling GitHub in the background — a device flow cannot complete inside a
  request. It is idempotent: a second `POST` while one is live returns the SAME
  code rather than minting a rival the server has stopped polling. The
  `device_code` never leaves that module (it is the bearer half of the exchange),
  and neither does the token.
- **Why the UI is NOT the Google rows.** Those drive an OAuth REDIRECT. This is a
  DEVICE flow, so the screen is built around the CODE: Connect POSTs to start,
  the `user_code` is displayed large and monospaced, Copy puts it on the
  clipboard in one press, the `verification_uri` is a real link, and the client
  POLLS the status route (5s, GitHub's own floor) until it answers `connected`
  and re-renders. Typing that code into another device IS the interaction. The
  poll runs ONLY while a code is on screen — `not_connected` never spins one — it
  is torn down the moment the flow settles, and a poll that fails to reach the
  server leaves the code where it is rather than reporting a disconnection the
  owner did not experience.
- **A failed READ never blanks a live flow, on either surface.** The same rule
  covers the mount-time status read, not only the poll: that read re-fires
  whenever the client is rebuilt (the token rotating under a long-lived tab is
  enough), so `awaiting_owner` survives any failed read and only a SUCCESSFUL one
  can leave it. Otherwise one flaky moment mid-flow takes the owner's code away
  and tears down the poll that was about to see the approval. The release valve
  is the poll itself: the gateway drops a pending grant once it expires and
  answers `not_connected`, so a code that goes stale clears on the next tick and
  a Connect control comes back — no reload, no Refresh. That is what keeps this
  rule from stranding a screen on a code that is no longer good.
- **Every state that is not connected and not mid-flow offers Connect.** The
  clients CAST the wire payload to the three-state union without validating it,
  so a gateway that grows a fourth state arrives as a plain string; gating the
  control positively on `not_connected` would render a row saying "Not connected"
  with nothing to press. Both surfaces gate it negatively instead — a screen with
  no way out is worse than one offering an action that may be redundant.
- **Both surfaces.** Web `landing/chat-react/IntegrationsTab.tsx` § GitHub over
  `landing/chat-react/github-connect-client.ts`, rendered OUTSIDE the
  `/api/cores/integrations` load so a blocked owner's control never waits on an
  unrelated round trip. Mobile `app/app/integrations.tsx` § GitHub over
  `app/lib/github-connect-client.ts`, which additionally re-reads status when the
  app returns to the foreground (the owner taps "Open GitHub", approves, comes
  back). No feature flag; single code path, on by default.
- **How it is gated.** Two seams, deliberately. The web reachability gate carries
  a `github-connect` affordance probed at EVERY layout after walking the real
  path to Admin (header menu → Admin), so the control cannot silently leave one
  width. Alongside it, `landing/chat-react/__tests__/github-connect-reachable.test.tsx`
  and `app/__tests__/github-connect-reachable.test.tsx` PRESS the control and
  assert the wire: the POST leaves, the code renders, Copy reaches the clipboard,
  the link opens, the poll flips to connected and then stops, a dropped poll does
  not blank a flow that is working, and the `device_code` is not rendered even
  when a response carries one.

### Code-generation model selector — one tier registry, three model families

Which model runs each step of a build is owner-editable, as a TABLE: one row per
named step — **name · model dropdown · effort dropdown** — plus the step's one-line
explanation, then Save. Web `landing/chat-react/SettingsTab.tsx` (§ "Code
generation"), mobile `app/app/codegen.tsx`, both over
`GET`/`PUT /api/app/trident/phase-models` (`gateway/http/trident-phase-models-surface.ts`).

- **The unit of choice is a TIER, not a model id.** `trident/model-tiers.ts` is the
  ONE registry: `{tier, provider, model_id, transport, wrapper, env_var, requires}`,
  where `model_id` is RESOLVED AT CALL TIME (the Claude tiers through
  `runtime/models.ts`, including the watchdog's adopted `getBestModel()`). Retiring a
  model is a single edit here. Tiers: `fable`/`opus`/`sonnet`/`fast` (Anthropic),
  `sol`/`terra`/`luna` (GPT 5.6, via Codex), `k3` (Kimi K3).
- **A tier carries a TRANSPORT, because that is what makes it reachable.** The
  workflow cannot reach a non-Anthropic model through `agent({model})` — that
  resolves against Claude Code's own endpoint (`trident/kimi-review-cli.ts`). So
  `transport: 'agent'` goes on the spawn, and `transport: 'cli'` is passed to a
  SUBPROCESS through the wrapper's env knob: `CODEX_REVIEW_MODEL` for
  `trident/codex-review.sh`, `KIMI_MODEL` for `trident/kimi-review-cli.ts`. The
  registry is threaded to the workflow as `args.modelTiers` (`trident/inner-loop.ts`
  `buildWorkflowArgs`), alongside the existing `args.models`, because the `.mjs` has
  no module resolution.
- **The cross-model review lanes are routed phases.** `argus:codex` / `argus:kimi`
  (and their retry lanes) were in `UNROUTED_LABELS`; they are the `review_codex` /
  `review_kimi` phases in `trident/phase-models.ts`, defaulting to `sol` and `k3` —
  the same models the wrappers pinned themselves, so an install that never opens the
  pane is unchanged. `trident/__tests__/model-tiers.test.ts` pins the registry
  against each wrapper's own default (and against the `${VAR-x}` form that lets an
  explicitly EMPTY `CODEX_REVIEW_MODEL` mean "the CLI default").
- **THE BUILD STEP RUNS ON CODEX TOO.** It is the one step with two executors, and
  the reason is the Anthropic quota: the build is by far the most expensive phase.
  Pin the **Build** row to `sol`/`terra`/`luna` and `trident/inner-workflow.mjs`
  hands the assembled Forge brief to `trident/codex-build.sh` instead of to
  `agent({model})`; no Anthropic model id is requested for the phase. The wrapper
  runs `codex exec --sandbox danger-full-access` inside the step's isolated worktree,
  and its own knob is `CODEX_BUILD_MODEL`, never the reviewer's `CODEX_REVIEW_MODEL`.
  `workspace-write` writes only inside the workspace and a build writes outside it
  twice — a worktree's `.git` points at `<repo>/.git/worktrees/<name>`, and the diff
  goes under `/tmp`; `--add-dir` can widen the write set but cannot grant the network
  a build needs to fetch a base branch or install a dependency.
  - **THE PUBLISH BOUNDARY: the inner tree commits; the durable outer loop publishes.**
    `trident/codex-build.sh` contains no push, PR-create, or GitHub-authentication command.
    A pr-mode workflow hands its measured local commit to `trident/orchestrator.ts`, then
    stops. The outer loop verifies the named local branch still points at that commit,
    pushes an explicit refspec through its credentialed host runner, and independently
    runs `git ls-remote --heads origin` before it accepts `REMOTE_HEAD`. It similarly
    reads an existing PR or creates one and reads it back. Only after both facts exist
    does it re-fire the workflow from `outer-published:<sha>` for review. The credential
    is injected at the host-command boundary in `open/composer.ts`; it never enters the
    wrapper command, the Forge transcript, or any process below the inner workflow.
  - **The child shell's environment filter STAYS ON.** The sandbox grant says the shell
    MAY reach the network; it says nothing about what environment it is handed.
    `codex exec` filters that (`shell_environment_policy`), defaulting to
    `inherit = "core"` plus a default exclude list of `*KEY*`, `*SECRET*`, `*TOKEN*`.
    An earlier version of the wrapper turned both off (`inherit=all` +
    `ignore_default_excludes=true`) to deliver `GH_TOKEN` and `GIT_CONFIG_KEY_0` to the
    build's push, and that was wrong twice: the credential is wired to trident's OUTER
    loop only (`open/composer.ts` `run_host`), so the inner workflow that launches the
    wrapper never had it to inherit — `SPEC.md` records `/proc/<pid>/environ` as
    verified free of `GH_TOKEN` and `GIT_CONFIG_*` — while clearing the excludes DID
    expose the owner's Anthropic credential, which
    `gateway/wiring/build-import-substrate.ts` puts in that same REPL environment as
    `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`. It handed the quota this route
    exists to conserve to a GPT-driven `danger-full-access` shell, and bought an
    anonymous push with it. So the defaults stay, plus
    `-c shell_environment_policy.exclude=["ANTHROPIC_*","CLAUDE_*","KIMI_*","GH_*","GITHUB_*"]`
    — not redundant, because the defaults catch those only by substring coincidence in
    another project's pattern list. `--strict-config` is what stops that line becoming
    decoration: without it an unrecognised `-c` key is accepted and ignored, so a
    renamed field would silently stop excluding anything. The metered `OPENAI_API_KEY`
    is `unset` before `codex` is launched, separately and earlier. The two GitHub
    families are the NEW entries and they are the publish boundary's other half: the
    wrapper's own environment may now hold a GitHub credential, and the build must not
    inherit it — so on top of the config line, `GH_TOKEN` and `GITHUB_TOKEN` are
    `env -u`'d off the `codex` process itself, one level above the CLI's filter, where
    their absence does not depend on the CLI honouring a config key. The direction is
    the whole design: the sandbox LOSES a capability, it never gains one.
    `trident/codex-build.test.ts` asserts that absence against the mock `codex`'s own
    dumped environment, with a same-family decoy (`GH_TOKEN_DECOY`, which survives) and
    a `gh` call log showing the HOST had the token in the same run — so the negative is
    read beside two positives rather than alone.
  - **The HOST's ability to publish is checked BEFORE the tokens are spent.** The
    precheck changed SUBJECT with the split, not place: it used to ask whether the
    sandbox could push, which no longer matters, and now asks whether THIS PROCESS can
    run the two commands it is going to run — still before `codex` is launched, so a run
    that cannot deliver costs a round and no tokens instead of a full build reported as
    "produced no commitSha — nothing was built". Both halves are probed, because having
    only one is what produced the incident: `git credential fill` against the push
    remote's host (the same helpers a real push consults) and `gh auth status` (the tool
    that will open the PR, asked whether it can). Each MEASURES A CAPABILITY rather than
    testing for `GH_TOKEN`, so any configured mechanism passes; ssh and filesystem
    remotes are skipped rather than failed (a key authenticates those, never a helper);
    a missing `gh` is a different DEFERRED message from an unauthenticated one, because
    they are different things to install; and no secret is ever printed, logged or
    stored. Both are `pr`-mode-with-an-origin only.
  - **The merge mode is an ARGUMENT, not an inference.** Five checks are pr-only — the
    remote baseline, the two publish prechecks, the publish itself, the pushed-sha
    witness and the `gh pr list` probe — and the wrapper is handed the run's mode as
    `$3`. Keyed instead on "does an `origin` exist", which asks about the CLONE and not the RUN,
    any local-mode build in a clone with an unreachable origin hard-DEFERRED before
    codex launched, every round; and a local build standing on a branch that happened
    to have an open PR reported that unrelated PR's number where the contract says
    null. An absent or unrecognised `$3` means `pr`, the strict side of all four.
  - **The downstream contract is MEASURED, not narrated.** `codex exec` does accept
    `--output-schema`, but a schema-shaped answer is still the model reporting on
    itself and the failing case is the build that believes it committed. So after it
    exits the wrapper WRITES a six-line `NEUTRON_CODEX_BUILD_*` trailer it read from
    `git rev-parse --verify HEAD`, `git ls-remote`, `gh pr list`, and the diff file's
    existence. Any value it cannot establish is EMPTY, and empty fails closed at
    `roundLanded` and at the merge. A thin bridge agent copies those six values into
    the result schema — the same shape the codex REVIEW seat has, because `agent()` is
    the only primitive the workflow runtime gives this script.
  - **The trailer is a FILE, and both shas are about THIS build.** It goes to
    `NEUTRON_CODEX_BUILD_TRAILER_FILE` (required; the bridge `cat`s exactly that) so a
    transcript narrating trailer-shaped lines cannot compete with the measurement on
    disk. The trailer is also the wrapper's sole completion signal: both its success
    and failure branches write it, so an empty or missing trailer is a hard DEFERRED
    failure meaning the wrapper was killed before it could report. The terminal result
    names the trailer, stderr artifact and preserved worktree, including whether that
    worktree holds uncommitted work; it never calls this state "produced nothing".
    The trailer and transcript are not one stream. `HEAD` is reported only when it is
    a commit that did not ALREADY exist
    — measured against three tips, the worktree HEAD at launch plus the local and
    remote tips of the target branch — so neither a build that edited without
    committing nor a re-entry that only ran `git switch` can hand back a sha it did
    not produce. The diff path is deleted before launch for the same reason: it
    survives between rounds, and an unrewritten one would point the panel at an
    earlier round's diff — and when a build DID commit and wrote no diff, the wrapper
    takes `git diff <base>..HEAD` itself rather than reporting a path it just deleted.
    A head measured on the WRONG BRANCH is empty for the same reason a missing commit
    is: a wrong-branch commit passes every later gate while `git merge --no-ff
    <branch>` lands none of it, and local mode then deletes the branch that held it.
    The measured branch name still ships and `forgeAgent` compares it, so the run stops
    naming the branch instead of reporting an unexplained missing sha. Every remote
    probe is wall-clock bounded and reads THROUGH A FILE — `gh pr list`, both
    `git ls-remote` probes and the auth precheck, all through one `bounded()` helper:
    `emit_trailer` runs on the failure path too, so an unbounded call there hangs the
    phase instead of losing a field, and `$(…)` returns when the PIPE closes rather
    than when the process exits, which is why the alarm alone was not a bound. `perl`
    is a declared dependency of the wrapper, refused by name rather than surfacing as
    a false "auth expired". `REMOTE_HEAD` is that sha CONFIRMED PUSHED — emitted only when the
    remote tip equals it — because a fresh probe of a shared ref is what
    `inner-workflow.mjs` forbids for `reviewedHead`: a third-party push read back there
    would be pinned by `--match-head-commit` and certified as reviewed. That witness
    probe is asked up to three times, and only when it FAILED: an unanswered one costs
    the run the whole build ("produced no commitSha — nothing was built" about a build
    that pushed), while a probe that completed has given a real answer and re-asking it
    is the one way a true "not pushed" could become a false "pushed". The PRE-LAUNCH
    baseline probe asks the same three times, because asking once while the witness
    asked three was itself the bug: a blip that defeats one attempt but not three drops
    the remote-only tip from the baseline and the witness then confirms it as pushed, so
    a re-entry that committed nothing reports the previous round's sha as its own. When
    all three baseline attempts fail the run exits 3 (DEFERRED) instead of building — a
    baseline nobody measured is not a baseline, and refusing before launch costs a round
    and no tokens. `remote_tip` distinguishes "the branch is not there" (empty) from
    "no attempt was answered" (the literal `unknown`); a repo with no `origin` skips the
    probe without deferring, since it cannot have a remote-only branch.
  - **Nowhere to write the trailer is refused BEFORE the tokens are spent.** The
    trailer-file precheck proves the path by writing it (`: > "$TRAILER_FILE"`), not by
    testing that the variable is set: the single `>` in `emit_trailer` fails silently
    under `set -uo pipefail`, so an unwritable path let a completed build exit 0 having
    reported nothing, and the workflow then said "produced no commitSha" about a build
    that built everything.
  - **The brief carries a receipt.** The workflow reaches a shell only through a bridge
    agent that must reproduce the whole brief in a heredoc, so the command ships
    `<bytes>:<fnv32>` for exactly those bytes and the wrapper recomputes both before
    spending a token — a truncated or reworded brief is DEFERRED rather than built.
    FNV-1a/32 because the composing script has no imports and no promised host API; it
    is a corruption check, not a signature. Its UTF-8 encoder is written out longhand
    rather than borrowed from `encodeURIComponent`, which THROWS on the unpaired
    surrogate a length-capped task text leaves behind mid-emoji. And the bridge gets
    exactly one retry on that specific exit: the wrapper refuses before spending a
    token, so a re-copy is cheap, while a copying wobble with no retry abandons an
    already-built branch. A second identical failure is final.
  - **No fallback to Claude, and no review of nothing.** A lane reporting
    `not_connected`/`deferred` stops the run with the status named — re-Forging on
    Opus would spend the quota the owner moved the phase to protect, invisibly. A lane
    that CONNECTED and produced no sha or no diff stops too: round 1 had no
    did-it-land gate, so an empty build reached the panel and five reviewers APPROVED
    a change that did not exist. That gate sits after the PR capture, the `forge-done`
    checkpoint and the Ralph re-fire — it guards the review PANEL, and an intermediate
    Ralph task opens none.
  - **A codex build makes the codex REVIEWER same-family.** The cross-model gate is
    unchanged and still cannot turn a deferred review into an APPROVE, but on a codex
    build the panel's family diversity comes from `argus:claude`,
    `argus:adversarial` and the kimi seat.
- **The effort cell follows the CHOSEN tier, not just the step.** The payload carries
  `effort_supported` on each PHASE (does its default executor read one) and on each
  TIER (does that tier read one), and both clients disable the cell when either says
  no — the build row keeps its control on `opus` and loses it on `sol`. Both reads are
  `!== false`, never truthiness: an older gateway omits the field, and `undefined`
  under a truthiness test would blank every effort control at once. `applyRowEdit`
  clears an effort the newly-chosen tier cannot use; `parsePhaseModelConfig` drops one
  that arrives anyway and lets the write SUCCEED, because failing it
  400s the whole PUT and makes the codex tiers unpickable for anyone who ever touched
  the build's effort. An effort on a phase that never had a control is still an error.
- **Otherwise a row offers only its own executor's tiers, and says so about the
  rest.** The payload carries `groups` (every executor the step dispatches on) beside
  `group` (its default), and `tierChoices` greys by `groups`. Every tier is listed;
  one from a group this step cannot reach renders disabled with "<Executor> is not
  wired for this step yet — it runs on <every executor the step reaches>", and one this
  install cannot run with the reason that NAMES THE MISSING PIECE — never disappearing.
  The surface answers availability from the SAME resolvers the build uses (the shared
  `kimiConfigured()` that `resolve_kimi_configured` also uses), and from ALL THREE
  preconditions of "can codex run here", via one function
  (`codexExecutorAvailability` in `trident/codex-credential.ts`, called by
  `open/composer.ts`): a credential (`resolveActiveCodexHome`), the `codex` CLI, and
  `perl`. The wrapper hard-fails on each — exit 10, exit 11, exit 3
  `CODEX_BUILD_NO_PERL` — so the pane and the run cannot disagree. It returns
  `{ usable: true }` or `{ usable: false, reason }` rather than a boolean, because the
  gate grew from one condition to three while the string stayed "needs a Codex
  connection", sending an owner whose login was fine to a `codex login` that changed
  nothing; the surface derives `available` FROM the reason, so a greyed tier without an
  explanation is unrepresentable. Both PATH probes require an executable REGULAR FILE —
  `X_OK` alone passes for any directory named `codex`.
- **One step is never two rows, and a follower is never settable.**
  `build_mechanical` is the build step under the planner's internal `[mechanical]`
  tag; it DECLARES that it follows `build` (`TridentPhase.follows`), the workflow's
  `phaseOverrideFor` hands it `build`'s setting UNCONDITIONALLY, and neither the
  surface's `phases` nor its `defaults` renders it. All three are required: inheriting
  without hiding is a row showing `sonnet` beside a run that dispatched the owner's
  codex tier, and hiding the row while still accepting a value for the key leaves a
  stored override the owner can neither see nor clear — which kept `[mechanical]`
  tasks on Anthropic after Build moved to codex. `parsePhaseModelConfig` rejects the
  key by name, so the PUT 400s and the read path drops a value stored before the rule.
- **A refused stored value degrades visibly.** `model` must name a tier (the old
  literal-id escape hatch is closed: a bare id carries no transport). A retired tier
  or a legacy literal is rejected at the boundary, the phase falls back to its
  default, and the payload's `rejected` map lets the row show it struck through with
  what is running instead. The workflow backstops the same case by logging
  `trident.phase-override IGNORED … reason=unknown-tier` and keeping the default.
- **Scope is install-wide and the pane says so.** Storage is
  `instance_metadata.trident_phase_models` keyed by instance slug — there is no
  project dimension, so the section is labelled "every project on this computer"
  rather than pretending to one.
- **The chain is asserted end to end**, not per layer:
  `trident/__tests__/cross-model-dispatch.test.ts` runs the REAL `buildWorkflowArgs`
  output through the REAL `inner-workflow.mjs` and asserts the resolved id lands on
  the subprocess command line (`CODEX_REVIEW_MODEL='gpt-5.6-terra'`,
  `CODEX_BUILD_MODEL='gpt-5.6-terra'`), with a positive control beside every absence
  assertion. `trident/codex-build.test.ts` spawns the wrapper against real temporary
  git repositories — including a real bare origin and a sha256 repo — and drives it
  into each state the trailer must tell the truth about.
- **Review executor topology.** `review_adversarial` joins `build` and
  `build_mechanical` in declaring `alsoRunsOn: ['codex']`; that declaration makes GPT
  tiers selectable and is mirrored by the route in `trident/inner-workflow.mjs`.
  Selecting one changes the adversarial seat from an Anthropic `agent({model})` call
  to a thin command bridge that runs `trident/codex-review.sh`. The bridge exports
  both `CODEX_REVIEW_MODEL` and the adversarial rubric, so the subprocess still tries
  to refute the change rather than silently becoming the generic cross-model seat.
  `review_rubric` remains Claude-only by default and by capability. CLI tiers expose
  no effort control; the clients derive that from the selected tier's transport.
  A deferred or dead codex-backed adversarial seat remains a missing core seat and
  is forced to `REQUEST_CHANGES` by `enforceCrossModelGate`.

## Voice-note transcription — the owner picks the backend (`gateway/transcription/`)

A voice note is transcribed at upload-complete time and the transcript is
persisted as a content-addressed `<hash>.txt` sidecar beside the blob; the live
turn then inlines that text (the agent cannot read raw audio). The upload surface
(`gateway/http/app-upload-surface.ts`) owns the sidecar and calls ONE injected
`transcribeAudio` seam — it knows nothing about which backend answers.

**Two backends, one contract.** `gateway/transcription/types.ts` defines
`TranscribeResult`; both implementations satisfy it and NEITHER throws (ASR must
never fail an upload):

- `local-whisper.ts` — spawns `whisper-cli` on this machine. No API key, no
  network, no per-minute cost, and the audio never leaves the box.
- `openai-transcription.ts` — the hosted `POST /v1/audio/transcriptions` client.

**The SETTING decides — there is NO precedence** (`resolve-transcriber.ts`).
`instance_metadata.transcription_backend` (migration 0111) holds `'local'` or
`'openai'`, and that is the only input that ranks the two. The earlier rule
("local wins when installed, unconditionally") is DELETED, not demoted: it made
the two mutually exclusive — with local installed there was no way to reach an
OpenAI key short of deleting the install — and a rule left underneath the setting
as a hidden tiebreaker would reassert itself the next time a backend was
installed or a key pasted. Owner's ruling: *"I think it should just be a setting
for which transcription tool to use."*

Resolution, per call (not at boot, so a change takes effect on the very next
voice note without a restart):

- **chosen backend can run** → it runs.
- **chosen backend cannot run** → `none`, with a reason
  (`local_not_installed` / `openai_key_missing`). NEVER the other backend:
  substituting would either ship audio off a box whose owner asked for local, or
  silently downgrade quality for one who asked for OpenAI.
- **never chosen, exactly one backend configured** → that one. A self-hoster who
  only ever set `OPENAI_API_KEY`, or only ever installed local Whisper, is
  unaffected and never has to visit the setting.
- **never chosen, BOTH configured** → `none` / `unchosen`. The question is real
  and unanswered, so both Settings surfaces ask it and the composer logs
  `voice_transcription_unconfigured` rather than guessing where the audio goes.

**The OpenAI API key** is owner-entered in Settings and stored where every other
owner-entered credential lives: the AES-256-GCM `ProjectCredentialStore`
(migration 0092, shared `.neutron-aes-key`), GLOBAL scope, reserved service name
`openai_transcription` — the same shape as the Codex subscription bundle.
`gateway/transcription/openai-key-store.ts` owns it.

**ONE OpenAI key serves every OpenAI-backed feature** (SPEC § Decisions Log
2026-08-04). The key resolves in THREE steps — dedicated `openai_transcription`
credential → the SHARED general OpenAI credential → `OPENAI_API_KEY` from the
server environment — and the status object reports WHICH source supplied it
(`stored` / `shared` / `environment`). Step 2 is why a key pasted once for
semantic search also transcribes voice notes: the general credential lives in a
DIFFERENT store — `ApiKeyStore` over `SecretsStore` (tables `api_keys` +
`secrets`, secrets label `openai:onboarding`), written by the onboarding
optional-key offer and by Settings → Integrations, read by
`gateway/wiring/resolve-onboarding-openai-key.ts` — not in `project_credentials`,
so the fallback crosses a store boundary via a lazy thunk the composer injects
(the same thunk the GBrain embedder wiring uses, lazy for the same reason: the
composer runs once at boot, the key is pasted later). Step 1 still outranks it,
which is how anyone who wants transcription billed to a SEPARATE key gets that.
This replaces an earlier isolation rule — a distinct service name so a key
pasted for one purpose could not switch on another — which was retired because it
protects a user Neutron does not have: there is one owner, he pastes his own key,
and a second mandatory paste read as a bug.

**It is write-only**: responses carry `{ present, source, saved_at }` and never
the key or any slice of it (this repo omits secret material rather than masking
it). A key this surface does not own cannot be deleted over HTTP — an
environment key returns 409 `key_from_environment` pointing at the server's
`.env`, and a shared key returns 409 `key_from_shared_credential` pointing at
Integrations. `saved_at` is `null` for both, because that timestamp would imply
the key is this panel's to manage.

**Install is opt-in, from Settings — nothing ships in `install.sh`.**
`whisper-catalog.ts` pins the whisper.cpp release build and each ggml model by
URL, byte size AND SHA-256. `whisper-install.ts` streams each artifact to a
`.part` file while hashing it and only `rename()`s it into place on an exact
digest match, so an interrupted or corrupted download leaves NOTHING installed
(safely re-runnable rather than byte-range resumable). Disk space is checked
before the first byte. Assets live at `<NEUTRON_HOME>/whisper/{bin,models}`;
`NEUTRON_WHISPER_BIN` / `NEUTRON_WHISPER_MODEL` override them, so a machine
running several instances can share ONE copy of the weights.

**Surfaces.** HTTP `gateway/http/voice-transcription-surface.ts` —
machine-scoped `/api/app/voice-transcription` (GET status + catalog + live job
progress, POST install, DELETE remove), plus `PUT …/backend` (choose one) and
`PUT`/`DELETE …/openai-key`. Every route answers with the SAME status object, so
a client re-renders from the reply rather than re-fetching. POST returns 202
immediately; the client polls the GET for real byte counts, rendered as a
progress bar. `backend` in that object is computed by CALLING `resolveTranscriber`
— the surface used to carry its own copy of the rule, which is how a status line
drifts from what the box actually does.

TWO clients drive it, because voice notes are mostly recorded on a phone and a
switch that only exists on the desktop is, for a mobile owner, unshipped:

- **web** — `landing/chat-react/voice-transcription-client.ts` →
  `SettingsTab.tsx` § "Voice transcription".
- **mobile** — `app/lib/voice-transcription-client.ts` +
  `app/lib/voice-transcription-view.ts` → `app/components/VoiceTranscriptionCard.tsx`,
  mounted on `app/app/settings.tsx`. The wire types are re-declared rather than
  imported (no browser package in the Metro bundle) and held in sync by
  `app/__tests__/voice-transcription-settings.test.ts`'s mirror-parity block.
  Mobile-only behaviour: model options are tappable rows carrying each model's
  measured cost instead of a `<select>`; a foreground `AppState` refetch resumes
  polling after a backgrounded phone (the job is unaffected — it lives in the
  gateway process, so only the WATCHING pauses); a 404 is reported as "this
  server is older than the API" rather than a generic failure.

Both surfaces lead with ONE line naming the backend that is transcribing RIGHT
NOW — the complaint that produced this feature was not knowing which was in use —
and when nothing is, they say which of the four situations it is rather than one
generic "not transcribed". Both clients also normalize a status response from a
server older than the choice feature, since a store-published app build routinely
outlives a server version and reading an absent field mid-render takes the whole
screen down.

`binary_present` (alongside `binary_downloadable`) reports whether a runnable
`whisper-cli` is already on the box. The pair is the whole truth about whether
Install can succeed: on `false`/`false` the owner must run a package manager ON
THE SERVER, which no client can do for them, so the mobile card replaces the
button with that explanation rather than offering a control that would fail.

**Measured cost** (8-core AMD EPYC-Milan @2.4 GHz, AVX2, no GPU, `-t 4`,
whisper.cpp v1.9.1, 30-second note): `base` 3.8 s / 343 MB RSS; `small` 12.4 s /
813 MB; `large-v3-turbo` 50.0 s / 1.9 GB. Default is `base` — transcription runs
INSIDE the upload request, so model choice is felt directly as how long the owner
waits after speaking. Plain `large-v3` (69.8 s, 3.97 GB RSS) and every q5
quantization (measured SLOWER than the f16 weights they shrink, on this CPU) are
deliberately not offered. Those numbers are CPU-only; GPU-accelerated hardware
runs the same models far faster, so the Settings copy attributes the slowness to
the machine rather than presenting local transcription as the worse option.
`whisper-cli` decodes wav/mp3/ogg/flac natively;
`audio/mp4` (iOS Safari's recorder output) is normalized through `ffmpeg` when
present and refused with a precise `unsupported_format` when not.

## Work Board — orchestrator external memory + live work tracker (`work-board/`)

> **M1 UX redesign (2026-07-02).** The Work list (user-facing tab "Work") renders
> each active row as `[dot] title … [phase tag] [round] [actions]`, consuming
> PR-1's `step_label`: a leading dot that pulses in the phase color while a build
> walks building→reviewing→fixing→merging (solid red/green on failed/done), a
> typographic phase tag (Building / Reviewing / Fixing / Merging / Merged /
> "Didn't finish"), and a muted `round N`. The old emoji-glyph status noise, the
> `⑂`/`›` activity glyph, and the elapsed-minutes timer are GONE. Rows reorder by
> DRAG (a `⠿` grip) instead of ▲▼ arrows; ✕ delete asks to confirm; ▶ starts a
> not-started card and ↻ retries a failed one; completed items collapse under a
> "Done · N" disclosure (default closed) with a "Merged · Jul 2" date; the
> add-item box sits at the BOTTOM. In chat, errors are ordinary agent bubbles and
> the system-message style (a quiet centered pill) is reserved for true
> notifications (the cold-start "Waking up…" ack).

Phase 1a (backend). The Work Board moves the orchestrator's per-feature state
**onto disk** (`work_board_items`, migration `0090`, STRICT) so the chat
conversation becomes a thin, disposable query layer instead of a rotting
context window — and it doubles as a first-class per-project tab (UI = Phase
1b). One row == one thing the owner (or the agent) is working on / about to /
has finished. The board is **PER-PROJECT** (correctness bundle, 2026-07-02): the
HTTP surface keys every `store.*` call on `workBoardScopeKey(owner_slug,
<url project_id>)` — the bearer-derived owner slug bounds the scope (single-owner
box), the VALIDATED URL `project_id` selects the project within it (General → the
bare owner slug, which also carries every pre-scoping legacy row). So project A
and project B are DISTINCT boards; a `store.get(scope, id)` miss is a 404, so a
caller can't probe another project's items. The storage `project_slug` column now
holds that per-project key (no schema change — single-owner ∴ a bare project id
is a sufficient key). The `work_board_changed` push tags each frame with the
per-project `project_id` (via `workBoardProjectIdForKey`); the app + web clients
apply a frame ONLY on an EXACT board match (`(framePid ?? '') === projectId`),
where an untagged frame is the General board (`projectId` `''`/null) — NOT a
broadcast, so a General/agent write can't clobber an open project's live view
(Codex P2). The AGENT
`work_board_*` tools + the per-turn injection still key on the instance slug
(`ctx.project_slug` / `turn.project_slug`, hard-overridden in `mcp/server.ts`), so
the chat agent and the General Plan tab SHARE the General board; per-project
boards are human/HTTP + ▶-button scoped (a deeper per-project agent context is a
separate change).

- **Store** — `work-board/store.ts` `WorkBoardStore` (mirrors `trident/store.ts`,
  a typed `ProjectDb` wrapper). `sort_order` is a SIMPLE INTEGER with
  gap-renumber on reorder (not a fractional REAL). The append-at-end
  (`MAX(sort_order)+1`) and `reorder` (load-renumber) read-compute-writes run
  inside `db.transaction()` (a bare `.get()` bypasses the write mutex → race
  under N-parallel). `title` is newline-stripped + capped (256) at the store;
  `design_doc_ref` schemes are allow-listed at write (`https:` + an in-app docs
  link only — `javascript:`/`data:`/`file:` throw `WorkBoardValidationError`).
  `completed_at` is stamped on →done and NULLed on any re-open off done.
  Sub-agent activity is DERIVED via the `linked_run_id` join to
  `code_trident_runs` (Phase 2), NOT duplicated; only a lightweight
  `inline_active` marker is stored. ISO-8601 TEXT timestamps.
- **One canonical instance, one push.** The composer (`open/composer.ts`)
  constructs the SINGLE `WorkBoardStore` with an `onChange` hook and threads
  that same instance into (a) the agent tools, (b) the HTTP surface, and (c)
  the per-turn injection — so an agent mutation and a human HTTP write share
  one code path and fire one `work_board_changed` full-snapshot push to the
  owner's app-ws topic (`appWsTopicId(OWNER_USER_ID)`), mirroring
  `projects_changed`. Push is best-effort (never rolls back a committed write).
- **Agent tools** — `work-board/agent-tool.ts` registers `work_board_list /
  _add / _update / _complete / _reorder` on the `ToolRegistry` (non-hidden,
  `approval_policy:'auto'`, `read|write:project_data`); they ride the #87
  tools-bridge as `mcp__neutron__work_board_*`. `project_slug` is taken from the
  server-injected `ToolCallContext` (un-spoofable via `mcp/server.ts`), NEVER an
  agent arg — the schemas expose only `title/status/design_doc_ref/id/before|
  after`.
- **TodoWrite → board sync (WAVE 3.5 task B).** The warm orchestrator's NATIVE
  multi-step `TodoWrite` list now populates the board automatically — so
  multi-step work the agent is doing shows up as tracked cards, not only work it
  explicitly created via `work_board_add`. A NEW `PostToolUse` hook (matcher
  `TodoWrite`, sibling of the enforce-reply Stop hook) —
  `runtime/adapters/claude-code/persistent/hooks/todo-sync.ts` — reads CC's
  structured `tool_input.todos` from stdin and POSTs the list to the substrate
  reply-sink's new `/todo-sync` route (the SAME token-gated loopback the
  tool-bridge + dev-channel use; `SESSION_ID`/`SINK_PORT`/`SINK_TOKEN` baked into
  the hook command by `build-settings.ts`). `spawn.ts` wires the hook ONLY when
  `enableToolBridge === true` (the owner's warm conversational REPL) — the
  disposable Trident-build + untrusted history-import REPLs never enable it, so
  their internal TodoWrite stays build-internal. The sink route resolves the
  session's active `projectId` and dispatches to a late-bound `todoSyncRef`
  (mirror of `replToolBridgeRef`; the `todos` array is passed through untyped so
  the runtime module stays free of any work-board import). `composeProductionGraph`
  (via `build-core-modules.ts`, alongside `setReplToolBridge`) wires that ref to
  reconcile through the SAME shared `WorkBoardStore` at
  `workBoardScopeKey(owner_slug, project_id)` — so a synced create/update fires
  the store's `onChange` live-push exactly like any other write. Reconcile logic
  is pure (`work-board/todo-reconcile.ts` `reconcileTodosIntoBoard`, precedent
  `trident/board-reconcile.ts`): identity is the card TITLE (CC todos carry no
  stable id), sanitized like a stored title; statuses map pending→upcoming /
  in_progress→in_progress / completed→done; `task_type` defaults to 'build'. It
  is IDEMPOTENT — re-running `TodoWrite` with an unchanged list creates zero
  cards and issues zero status updates. Fail-soft end to end (missing env / bad
  payload / transport error / board-less boot all degrade to a silent no-op, never
  perturbing the agent turn).
- **HTTP surface** — `gateway/http/work-board-surface.ts` (human read+WRITE):
  `GET` + `POST/PATCH/DELETE /api/app/projects/<id>/work-board[/<item>[/<verb>]]`,
  bearer-gated exactly like the tabs surface (own `resolveBearer` +
  `sanitizeProjectId`), dispatching the same canonical store. Threaded
  composer → `composition.ts` (`app_work_board_surface`) → `compose.ts`
  (`appWorkBoard`, mounted ahead of `appProjects`).
- **Live trident progress + safe cancel (M1 trident-UX hardening).** A Plan item
  bound to a trident run now carries a `run_progress` payload on BOTH the HTTP GET
  and the `work_board_changed` push, derived (`trident/run-progress.ts`,
  `deriveRunProgress`) from the linked `code_trident_runs` row: a human phase label
  (planning/building/reviewing/merged/failed/cancelled — read off `phase` +
  `inner_checkpoint`, since the outer `phase` stays `forge-init` during the whole
  exec-model build), the round, elapsed since `started_at`, and a "stalled" flag
  when `last_advanced_at` is older than `STALLED_WARN_MS` (10 min). The web Plan
  tab renders it as a compact sub-label + polls every 15s while a run is live. **X
  cancels the build**: the `DELETE` handler stops a non-terminal `linked_run_id`
  (`phase='stopped'`, the existing trident stop path) BEFORE removing the card, so
  deleting a card can't orphan a running build; the client shows a confirm dialog
  first ("Cancel this build and remove it?"). Separately, the durable loop's
  **hang watchdog** (`trident/orchestrator.ts`, `NO_ADVANCE_HANG_MS` = 25 min)
  reaps a non-terminal run whose `last_advanced_at` has not moved — a suspected
  zero-token agent hang — to `failed` with a named reason, so it surfaces on the
  Plan item + fires the terminal notification instead of stalling silently.
- **▶ play button + on-disk spec persistence (M1).** A Plan card created from a
  NON-TRIVIAL ask now persists the FULL context to a real, user-visible markdown
  doc so it survives session resets and drives the build. `work-board/spec-doc.ts`
  (pure) decides triviality (a short one-liner stays title-only; multi-line or
  ≥20-word specs persist), builds the doc, and owns the `neutron-docs:` deep-link
  format; `work-board/spec-doc-service.ts` (`WorkBoardSpecDocService`) writes the
  doc to the **user-visible project docs** — `Projects/<id>/docs/plans/<slug>.md`
  (nested under `docs/` so the Documents tab serves + renders it; a sibling of
  `docs/` would not be served) — and sets the card's `design_doc_ref` to
  `neutron-docs:plans/<slug>.md`. Both the create path (`work_board_add`'s new
  `spec` param + the HTTP `POST` `spec` field) and the ▶ start path go through
  this ONE service; `ensureDocsDir` recursively creates the docs root first so a
  not-yet-materialized project scope never silently degrades to a title-only card.
  The **▶ (play) control** renders on a card that is NOT in_progress and NOT done
  and has no live run — i.e. an `upcoming` card never dispatched (START) or one
  whose last build failed/stopped (RETRY). ▶ dispatches through the SAME
  `dispatchBoardBoundBuild` chokepoint (required-item + ask-before-acting gate +
  `attachRun` binding) the agent uses, resolving the card's SAVED spec (its
  `design_doc_ref` doc content, else its title) as the run's `task` — so the doc
  IS the canonical spec the trident planning stage reads (one doc per card, no
  competing plan). Agent-native parity: `POST
  /api/app/projects/<id>/work-board/<item>/start` + the `work_board_start` agent
  tool are the exact same action. The card links to its doc via a tappable
  `📄 <name>` label that opens the Documents tab (reusing the `#148` doc-link
  nav). ▶ START has no confirm (cheap + intended); the `#174` X-cancel confirm is
  unchanged.
- **▶ routes BY TASK TYPE (#379) — research → Atlas, build → Trident.** A card
  carries a `task_type` ('build' | 'research', migration `0105`, DEFAULT 'build'
  so every legacy row + un-annotated create is a build). The web add-composer has
  a minimal Build/Research picker so a web-added research card does NOT default to
  a Trident build. The ▶ start route (`gateway/http/work-board-surface.ts`
  `handleStart`) branches on `item.task_type`: a 'build' card goes to `start_build`
  (the `dispatchBoardBoundBuild` Trident chokepoint above); a 'research' card goes
  to `start_research` — the general **agent-dispatch** service (`kind: 'research'`
  = Atlas). The research ▶ wiring is `agent-dispatch/board-research-start.ts`
  `createBoardResearchStarter` (extracted from the composer for testability): it
  binds the run to the card (same required-item + ask-before-acting chokepoint),
  and on the run's TERMINAL (success OR crash/cancel/timeout) it (a) marks the
  card terminal — `done` on `finished`, else `failed` — so the desktop pane
  auto-closes and the card is NEVER stranded in_progress, and (b) delivers the
  Atlas result back to the originating chat through the durable app-ws poster
  (persisted → renders in React), not a raw ephemeral registry send. Double-▶ is
  guarded two ways: the surface `409 already_running` on a card whose linked run
  is still live, plus a per-card `spawn_key` (+ `on_duplicate: 'coalesce'`) so a
  concurrent dispatch coalesces onto the in-flight run (no duplicate Atlas run).
  Deleting a research card cancels its agent-dispatch run (`cancel_dispatch` →
  `DispatchService.stop`) so the Atlas subprocess is not orphaned. LLM-less box: a
  research ▶ degrades to `501` exactly as a build ▶ does (no dispatcher wired).
- **Display roll-up counts plain active cards (#379).** `WorkBoardSummary` (web
  `WorkBoardTab.tsx` `summarize`) now carries `active` alongside `running`/`failed`:
  a non-terminal in_progress/inline_active card with NO live run
  (`linked_run_id: null`). The desktop pane (`PlansPane` controller) KICKS OPEN on
  `running` OR `active` rising, stays open while any of running/failed/active > 0,
  and auto-CLOSES only once ALL THREE are zero — so a plain in_progress/inline card
  (e.g. the agent working inline, or a research run in flight) opens the pane, and
  it closes when every card is terminal. Sticky + manual-toggle unchanged.
- **Per-turn injection** — `work-board/fragment.ts` `formatWorkBoardFragment`
  builds a compact `<work_board>` DATA block (active+next items, escaped +
  length-capped, + an advisory drift-guard line). `build-live-agent-turn.ts`
  injects it on EVERY turn via the `workBoardSnapshot` seam: the COLD first
  turn folds it into `instance_fragments` (the cacheable system prefix), and
  the WARM path splices it before the user's message — because
  `instance_fragments` is assembled ONLY on the cold turn, a fragment-only
  wiring would re-ground once per session, not every turn.

- **Tab UI (Phase 1b)** — a first-class per-project **Work Board** tab on both
  clients. The tab is registered ONCE in `tabs/registry.ts` (`BUILTIN_TABS` key
  `work_board`, label "Work Board", target `workboard`, **order 5** — between
  Chat=0 and Documents=10); both clients fetch the registry, so no client
  tab-list edits. **Web**: `landing/chat-react/WorkBoardTab.tsx` (a
  `tab.mount.target === 'workboard'` branch in `ProjectShell.tsx`'s `TabContent`)
  over `landing/chat-react/work-board-client.ts` (`WebWorkBoardClient`, the twin
  of `tasks-client.ts`); `cwb-`-prefixed styles in `chat-react.html` (reusing
  `--accent`/`#6cf` + `car-blink`, motion gated by `prefers-reduced-motion`).
  Live `work_board_changed` frames are applied via `controller.onWorkBoardChanged`
  (a board-only subscription, out-of-band of the chat ViewModel, mirroring the
  `projects_changed` apply). **Mobile**: route `app/app/projects/[id]/workboard.tsx`
  + `app/components/WorkBoardRow.tsx` over `app/lib/work-board-client.ts`, with a
  lightweight read-only socket `app/lib/work-board-live.ts` applying live frames;
  pure derivations in `app/lib/work-board-helpers.ts`; `StyleSheet` + `theme.ts`
  tokens only (`link:#5fb6ff` for "running", never the gray `accent`). The board
  renders FLAT one-line rows (NOT cards — distinct from Tasks): a status dot
  (hollow=upcoming / filled live-blue=in_progress / quiet=done), an activity glyph
  (fork `⑂`=sub-agent via `linked_run_id` / caret `›`=inline via `inline_active`,
  distinguished by glyph + a11y label, not color), and the completed history in a
  collapsed `▸ Completed · N` disclosure (dimmed, mono datestamp, reverse-chron,
  forever). HUMAN read+WRITE (add / inline-edit / advance status / reorder /
  delete) goes through the same `POST/PATCH/DELETE` surface the agent tools use.

**Phase 2b — board-bound dispatch + ask-before-acting (DONE).** Every autonomous
build / background agent now binds to a board item; the activity glyphs the UI
already renders are now LIT by real writers:

- **The chokepoint.** `trident/board-dispatch.ts:dispatchBoardBoundBuild` is the
  single trident dispatch chokepoint — shared by the human `/code --item <id>`
  grammar (`trident/code-command.ts`) and the agent-native
  `work_board_dispatch_build` tool (`trident/work-board-build-tool.ts`, the
  orchestrator fires N for N parallel builds). `agent-dispatch/service.ts`'s
  `DispatchService.dispatch` is the same chokepoint for `dispatch_agent` /
  `/dispatch --item`. All enforce, BEFORE any run/spawn: (1) **required
  `board_item_id`** — a dispatch without one is REJECTED (no untracked dispatches);
  (2) the item must EXIST; (3) **ask-before-acting** — `work-board/dispatch-readiness.ts`
  blocks an item with no `design_doc_ref` AND a terse (< 8-word) title, returning
  clarifying-question guidance instead of dispatching on assumptions.
- **Per-project build workspace (new-project buildability).** The chokepoint no
  longer hands the run row the owner HOME dir as `repo_path` (a non-repo, so the
  inner workflow's `isolation:'worktree'` / `git worktree add` failed at forge-init
  for any brand-new project). It resolves + git-inits (idempotent, with an
  `--allow-empty` INITIAL COMMIT — `git worktree add` needs a HEAD)
  `<owner_home>/Projects/<project_slug>/code` (`trident/build-workspace.ts:ensureProjectBuildWorkspace`)
  and writes THAT per-project path onto the run row, so each project's build is
  isolated and a project with no pre-existing code repo is buildable. A fresh local
  project has no GitHub origin, so merge mode degrades to `'local'` (branch + local
  merge, no PR) — the correct shape for a self-hoster's new project.
- **Serialized local merge (correctness bundle, 2026-07-02).** Two builds in the
  SAME project share ONE `code` workspace, so their local merges (`git checkout
  <base>` + `git merge --no-ff` in that one working tree) collide — build A's
  committed-but-unmerged files show as UNTRACKED when B checks out base ("untracked
  working tree files would be overwritten"). `trident/merge.ts:mergeLocal` now runs
  under a per-`repo_path` promise-chain lock (`withLocalMergeLock`): the second
  merge WAITS for the first, then checks out a base that already has A's files
  TRACKED and merges cleanly. Keyed on `repo_path` so DIFFERENT-project workspaces
  still merge in parallel; PR-mode (remote merge, never touches the shared tree) is
  not gated. A failed predecessor doesn't wedge the queue.
- **Robust terminal harvest (correctness bundle, 2026-07-02).** The inner workflow
  writes `subagent_status='completed'` in the SAME sqlite UPDATE that sets
  `inner_result` via `readfile()`. If that readfile yields null (temp file
  missing/unreadable, or a crash mid-write) the run was left `completed` with a
  null/garbled `inner_result`: `parseInnerResult` returned null so the harvest never
  fired, AND the completed-write re-stamped `last_advanced_at` so the hang watchdog
  was DEFEATED — the run stuck at `forge-init` forever (the taskdag symptom). The
  orchestrator harvest gate now treats a terminal `subagent_status`
  (`completed`/`failed`) with no parseable `inner_result` as a TERMINAL FAILURE
  (never merge — there is no verified result). Defense-in-depth: `writeTerminalResult`
  only flips `subagent_status` to `completed` inside a CASE guarded on the same
  `readfile()` being non-empty, so the two columns can't disagree at the source.
- **Binding + reconcile.** Success → `WorkBoardStore.attachRun` (`linked_run_id` +
  `status=in_progress`, clears inline → fork `⑂`). On a terminal run the durable
  `TridentTickLoop`'s `on_terminal` observer (`trident/board-reconcile.ts`, composed
  in `build-core-modules.ts`) calls `WorkBoardStore.detachRun`: `done` → completed
  (datestamped), `failed`/`stopped` → back to `upcoming`; binding cleared. The fork
  glyph is thus DERIVED from the trident row via `linked_run_id`, never a manual field;
  the caret `›` is the `inline_active` marker, settable via `work_board_update`.
- **No migration** — `0090`'s `linked_run_id` + `inline_active` + the partial index
  carry it; reconcile keys off `linked_run_id`.
- **Agent auto-invoke (Part B, M-K) — no `/code` needed.** The live chat agent
  SELF-ROUTES a build request via a complexity heuristic in the operating-doctrine
  fragment (`gateway/wiring/operating-doctrine.ts:BUILD_ROUTING_DOCTRINE`,
  spliced every turn) + the `work_board_dispatch_build` tool description: SIMPLE
  work (single file, quick script, small self-contained edit) is built INLINE with
  the agent's own Read/Write/Edit tools; COMPLEX work (multi-file, a real project or
  shared code, warrants review, large/risky) is routed to trident — the agent adds a
  Plan item (`work_board_add`) then calls `work_board_dispatch_build` bound to it,
  and TELLS the owner it is routing to trident and why. The tool is already on the
  live agent's surface (gated on the same Anthropic credential pool as the loop), so
  the owner never types a command — the agent decides.

See `docs/plans/2026-06-29-001-feat-work-board-master-plan.md` (§11 Phase 3/4).

## Activity Inspector — the live under-the-hood panel behind the activity dot

**The gap it closes.** The owner could not tell whether a project's agent session was
working or hung. In Vajra the escape hatch was attaching to tmux; Neutron's sessions
are server-side, so there was **no equivalent at all**. And the one signal that did
exist is known-untrustworthy: ISSUES #386 is the per-project rail dot pulsing for DAYS
on a real project while nothing ran. A binary "active" dot that has lied trains the
owner to ignore it. Clicking the dot now opens a panel streaming the raw substrate +
tool events for that scope in realtime, so "is it alive?" is checkable instead of
inferred.

**NOT the Work Board.** The board tracks work *items* and their statuses; this shows
what the agent is doing *right now* and dies with the process. Sibling features, no
overlap — do not collapse them.

**LIVE-ONLY (Ryan-locked, SPEC § WAVE 3.5).** ~200 rows buffered in memory per scope.
No persistence, no schema, no migration, no retention policy; scrollback is explicitly
future scope. A restart legitimately shows an empty panel.

### The two clocks — the design, not an implementation detail

The naive version of this panel would reproduce #386 exactly. `pool.ts` runs a
**synthetic liveness keepalive** that pushes `{kind:'status', message:'working'}` every
~10 s for as long as the `claude` child is alive — *including while it is livelocked or
parked on a wedged menu*. "Events are still arriving" therefore does NOT mean "work is
happening". So the keepalive push carries an additive `keepalive?: boolean` marker
(`runtime/events.ts`, same additive shape as `code` on `error`), and every scope keeps
**two** timestamps:

- `last_event_at` — ANY event, keepalive included ⇒ the **process** is alive.
- `last_real_activity_at` — keepalive EXCLUDED ⇒ **work** actually happened.

`deriveInspectorState` reads both and returns one of four states: `idle` (no turn in
flight — the resting state, and it must never look like a hang), `working`, `wedged`
(breathing but no real activity for `WEDGE_AFTER_MS` = 90 s — the #386 shape, and the
state the whole feature exists to name), `dead` (not even a keepalive for
`DEAD_AFTER_MS` = 30 s). `idle` is checked FIRST because a resting scope's clocks are
stale by definition. `turnStarted` records a NON-synthetic `turn_start` row, which is
what floors the wedge window: a turn whose only subsequent traffic is keepalives is
still detectable as stalled. A one-clock inspector can express none of this.

### Two server-side taps, because one is not enough

1. **The substrate event stream**, teed at the ONE drain —
   `runtime/substrate-text.ts` `DrainOptions.onEvent`. This was previously the end of
   the line: `status` / `thinking` / `tool_call` / `tool_result_ack` fell off the
   bottom of the if-chain and were discarded, so nothing in the process ever saw them.
   Threaded `build-live-agent-turn.ts` → `collectTokensToString` (4th arg) → the drain,
   scoped to `turn.project_id ?? 'general'` and bracketed by
   `turn_started`/`turn_finished`. Observe-only: a throw is swallowed at both the
   runner and the drain, so a broken inspector can never cost the owner a turn.
2. **A Pre/PostToolUse hook** — `runtime/adapters/claude-code/persistent/hooks/activity-tap.ts`
   → the loopback sink's `/activity` route → the composer's late-bound
   `setReplActivityTap` closure. **This is where the panel's real content comes from.**
   The persistent-REPL adapter's 1:1 bridge emits ONE whole-reply `token` and no tool
   events whatsoever, so the event stream alone can only ever say "alive", never
   "running Bash". The hook is wired on both phases with an unscoped matcher
   (`build-settings.ts` `activityTap`), APPENDING to the TodoWrite→board `PostToolUse`
   group rather than replacing it. `PreToolUse` carries the CALL (tool + its full
   arguments); `PostToolUse` carries the RETURN (`tool_response`, rendered by
   `renderToolResult` across the string / MCP-content-block / stdout+stderr /
   file-content / unknown-JSON shapes) — and a `pre` with no matching `post` for
   minutes IS the hang signal. Gated on `enableToolBridge`, so the disposable Trident
   build REPLs and the untrusted history-import REPL never report onto the owner's
   panel. Fail-soft throughout: missing env, bad input or a dead sink all exit 0.

### What a row shows — a transcript, not a ticker

Ryan 2026-07-30, on the first build: *"I like seeing tool calls, but they should be
human readable names. And interleaves with the actual messages the model is outputting
not just the size."* So a row carries `label` + `detail` (the collapsed one-liner) +
`body` (the expanded content, newlines preserved, capped at `BODY_MAX` = 2 000 chars —
which is also what bounds the ring at ~400 KB/scope and the fanned WS frame) +
`source`.

- **Names are humanised.** `humanizeToolName` parses `mcp__<server>__<tool>`: the TOOL
  becomes the label, the server becomes the dim `source` qualifier, and the
  per-session random incarnation `spawn.ts` appends is stripped so that qualifier is
  stable across spawns. **A raw transport id must never be a label** — it differs every
  spawn, so two calls to one tool would look like two different tools.
- **Assistant messages are rows.** The dev-channel `reply` tool call IS the agent's
  message (its `text` argument is the complete response), so it records as
  `kind: 'token'`, label `assistant`, interleaved with the tool rows on the one
  chronological timeline. Its `post` ack is dropped as noise.
- **The same reply arrives twice** — once from the hook (the call) and once from the
  substrate `token` that `onReply` pushes. `record` collapses an assistant row landing
  immediately after an identical assistant row, on ADJACENCY not a time window, so
  genuinely repeated content is never swallowed.
- **`thinking` is still unreachable** on the shipped CC path: the adapter emits no
  such event, so the intermediate reasoning a real CC transcript shows between tool
  calls is not on the wire at all. Closing that is an adapter change, not a panel one.

### Surfaces

- **Server:** `open/activity-inspector.ts` (the ring + the pure derivations; a `Map`
  and a few functions, no SQLite), constructed once in `open/composer.ts` and shared by
  all three seams. Live push: a new `activity_event` app-ws frame
  (`wire-types/app-ws-envelope.ts`) fanned to the base user topic AND every live
  `app:<user>:*` topic — the same reason `fanProjectsChanged` does it, since a web
  client inside a project holds only the project-scoped socket. Web and mobile share
  the transport (`resolveChannelTopicId` takes no platform argument), so one wire
  change lands both.
- **Snapshot read:** `GET /api/app/projects/<id>/activity` + `GET /api/app/activity`
  (General) — `gateway/http/activity-surface.ts`, bearer-gated, read-only, served via
  the `appActivity` slot in `gateway/http/route-slots.ts`. Load-bearing, not a
  convenience: a wedged session emits nothing, so a purely-live panel would open BLANK
  on exactly the session the owner is worried about and could not say how long ago the
  last event was.
- **Web:** `landing/chat-react/ActivityInspectorPanel.tsx` + `activity-client.ts`,
  mounted at the ProjectShell root (the rail is visible on every tab, so the check must
  be too). CSS `.car-actin-*` in `landing/chat-react.html`.
- **Mobile:** `app/components/ActivityInspectorDrawer.tsx` + `app/lib/activity-client.ts`,
  mounted beside `ProjectSettingsDrawer` in `app/app/projects/[id]/_layout.tsx`, using
  the locked built-in-`Animated` drawer contract.
- Both clients subscribe BEFORE fetching (so no row is lost in the gap) and dedupe on
  `seq` (which is what makes that overlap safe), and both age their clocks forward
  against the client clock every second — a frozen "12s ago" would be the same lie as
  a frozen dot.

### The dot is the entry point — and it is now always present

Ryan-locked: **no new icon**. `railDotClass` (web) / `railDotKind` (mobile) are
TOTAL — they previously returned `null` for an idle scope and for General, which would
have made the affordance disappear exactly when the owner wants it. General gets a dot
too: it is a real chat scope with its own warm session. General still never shows
ATTENTION (no bound runs) — it degrades to idle. On web the dot is a `role="button"`
span inside the row's existing `<button>` (a nested `<button>` would be invalid HTML)
with `stopPropagation`, so a dot tap inspects and does not also navigate; on mobile it
is a nested `Pressable` with `hitSlop`, present only on the ACTIVE row (an inactive
row's corner is inert, so a thumb aimed at a project cannot open the inspector for it
instead).

**Neither surface paints anything at REST.** Mobile went first (the owner, on device,
2026-07-31 — a grey ring on every row of a 72px rail read as a wall of state at a moment
when nothing was happening); web followed on the identical complaint about the web rail
("i dont want this hollow grey circle when there is no activity. I only want to see a
pulsing indicator when there is activity"). Mobile's `ActivityDot` renders a transparent
DOT-sized `dotSlot` for `idle`; web's `railDotClass` returns `car-rail-dot-none`, a rule
with no background, border or ring.

Only the PAINT was removed, and that distinction is the whole design. `railDotKind` /
`railDotClass` both stay TOTAL and still resolve `idle`, the element stays in the tree,
and it keeps its full hit target — mobile's `dotPress` Pressable with `hitSlop`, web's
`role="button"` span with its `::after` pad, `tabIndex`, `aria-label` and keyboard
handler. So an idle scope remains INSPECTABLE (the property the original always-visible
ring existed to protect — you cannot tell a resting session from a hung one without
opening the panel), the inspector is an invisible-but-tappable advanced affordance, and
a row does not shift the moment a dot lights up. Returning `null`, or rendering no
element, is what would actually unship the feature.

**`attention` is unaffected and still paints.** A quiet rail must never be bought by
hiding a broken scope: `deriveProjectActivity` (`open/project-rail.ts`) returns
`attention` for a failed not-done item or a stalled live run, and that stays a static
amber dot on both surfaces. Only the resting state went dark.

`app/__tests__/rail-idle-dot-not-painted.test.tsx` pins the mobile halves; on web,
`landing/chat-react/__tests__/component.test.tsx` asserts idle → `-none` (and that the
retired `.car-rail-dot-idle` rule is gone from the stylesheet, not merely unreferenced)
plus a dedicated case that `attention` still resolves to a class with a real fill, and
`activity-inspector-panel.test.tsx` asserts the unpainted dot is still clickable.

The chat surface keeps showing only its minimal curated messages — that terseness is
correct and stays. This is a separate surface.

## Create Project affordance — project rail + create-project capability

On a fresh install a skip-import owner had **no user-initiated way to create a
project** — projects only materialized at onboarding finalize, and reaching one
otherwise required the onboarding gap-fill quota (≥3 projects). The Create
Project affordance closes that: a button pinned at the **bottom** of the project
rail (rail order: **General → projects → Create Project**), plus a backend
create capability and an agent tool, so the owner (or the agent) can spin up a
fresh project + its tabs (Chat / Work Board / Documents) on demand.

**One code path (`gateway/wiring/project-create.ts`).** The shared
primitives `ensureProjectRow` (the real `projects` row + cli wow-shell `topics`
binding, idempotent, duplicate-safe, soft-delete-respecting) and
`buildScaffoldMaterializer`/`materializeProjectScaffold` (the on-disk
`Projects/<slug>/` docs + git repo + GBrain page) are the SAME functions the
onboarding finalizer (`build-onboarding-finalize.ts`) calls — the finalizer was
refactored to import them, so there is no second project-creation path. The row
write (fast, deterministic) is split from materialization (git + optional LLM
doc synth) so the create path awaits the row, fans the live rail refresh, and
kicks materialization fire-and-forget (failure-isolated; the materializer never
throws), exactly as finalize is itself dispatched.

**Backend HTTP — `POST /api/app/projects`** (`gateway/http/app-projects-surface.ts`,
bearer-gated like the rest of the surface). Body `{ name }` → `{ project: { id,
label }, created }` (201 fresh / 200 idempotent-existing). The optional
`createProject` binding degrades to `501 create_not_configured` where unwired
(read-only / Managed). Open wires the whole surface (`open/composer.ts`) — which
ALSO gives the mobile app's `fetchProjects` list a real backend (previously
unmounted in Open) — binding `createProject` + `create_project` to a single
`createProjectAndRefresh` that runs `createProjectRow`, the fire-and-forget
materialize, and `emitProjectsChangedNow` (an UNCONDITIONAL `projects_changed`
fan — unlike the diff-gated post-turn probe, so a skip-import owner's first
action still refreshes the rail). `project_slug` / `user_id` come from the
resolved bearer / `ToolCallContext`, never client/agent input.

**Agent-native parity — `create_project` tool** (`create-project-tool.ts`,
registered in `build-core-modules.ts` from the `create_project` composition
input; `approval_policy:'auto'`, `write:project_data`, non-`agent_hidden`). The
agent can create a project mid-turn through the same `createProjectAndRefresh`.

**Web rail** (`landing/chat-react/ChatApp.tsx` `TopicRail` + `chat-react.html`
`.car-rail-create`). The rail is a flex column with the `+ Create Project`
button pinned via `margin-top:auto`, ALWAYS visible (even with only General);
the rail itself always mounts now (previously hidden at zero projects). Click →
the button toggles to an INLINE name input (`.car-rail-input`, mirrors the
mobile pattern; Enter submits, Esc cancels, empty name shows an inline error —
NO native `window.prompt`, which is unstyleable and blocks E2E/CDP automation) →
`POST /api/app/projects` with the bearer → `controller.setProject(newId)`
navigates in; the live `projects_changed` frame refreshes the list (and 0→N
auto-selects the new project). A failed POST renders inline (no `window.alert`).

**Mobile rail** (`app/components/CreateProjectSheet.tsx` +
`app/app/projects/[id]/_layout.tsx` + `app/lib/projects.ts` `createProject` /
`projects-client.ts` `create`). The rail's `+` opens a create SHEET over the chat
with a name input → `POST /api/app/projects` → `router.replace('/projects/<id>/chat')`.
(Until 2026-07-29 this was a bottom-pinned `+ Create Project` bar on the
projects-list screen, and the rail's `+` merely navigated there; that screen is
deleted — see § "Mobile ENTRY".) No migration (the `projects` table already
exists, `0038`); the Work Board tab is automatic per-project
(`tabs/registry.ts`).

**Rail redesign (per-project emoji · activity-reorder · unread badge).** Each
rail row is `emoji chip · label · unread pill` (web `RailItem` in `ChatApp.tsx` +
the redesigned `.car-rail-*` CSS, theme-var-driven so it reskins with the #153
light/dark toggle; mobile `ProjectCard`). The list is ordered
most-recent-activity-first, so a project with a new message pops to the top:
`projects` gains `emoji` + `last_activity_at` (migrations `0093`/`0094`);
`last_activity_at` is stamped on create/materialize and bumped on each agent reply
to the project's topic (`open/composer.ts`, which then re-fans `projects_changed`
so connected rails reorder + re-badge live). `list()` and `readProjectRows()`
order by `COALESCE(last_activity_at, updated_at) DESC`. **Emoji** defaults to a
deterministic pick from the name (`gateway/projects/default-emoji.ts` — keyword
table + hash fallback; `GENERAL_EMOJI` = 💬), resolved from NULL at serve time so
legacy rows always show a glyph, and is editable in the Settings tab (PATCH
`{ emoji }`). **Unread** is honest: `unread_count` = agent messages on the project
topic (`app:<user>:<project>`) beyond the owner's highest READ receipt seq
(`app_chat_messages` ⋈ `app_chat_receipts`; the active project's badge is zeroed
client-side since viewing = read). No fabricated counts — the separate
`chat-topics-surface` no-fake-unread contract is untouched. The
`projects_changed` frame (`envelope.ts` `AppWsOutboundProjectsChanged`) carries
`emoji` / `unread` / `last_activity_at` per project alongside id + label.

## Archived projects — reversible archive + global Admin restore

A first-class ARCHIVE lifecycle DISTINCT from soft-delete (Ryan Q3, M2). Soft-delete
(`deleted_at`, migration 0053) hides a project from every surface with no way back;
**archive** (`archived_at`, migration 0095) hides it from the rail but keeps it in
the owner's Admin tab, restorable in one click. The two are orthogonal — the rail +
the archived list both additionally require `deleted_at IS NULL`, so a delete always
wins over an archive.

- **Column.** `projects.archived_at` (nullable ISO-8601, migration 0095 — plain
  `ALTER TABLE ADD COLUMN` on the STRICT table, like 0093/0094). `NULL` = active.
- **Store (`gateway/projects/sqlite-store.ts`).** `list()` (rail) + `readRow()`
  (settings GET/PATCH) filter `archived_at IS NULL`; `archive` / `restore`
  (idempotent, `deleted_at`-guarded so a deleted project is never touched) +
  `listArchived` (newest-archived-first, emoji resolved).
- **HTTP (`gateway/http/app-projects-surface.ts`).** `POST
  /api/app/projects/<id>/archive`, `POST .../restore`, `GET
  /api/app/projects/archived` — bearer-gated; archive/restore fan a live
  `projects_changed` via `onRailFieldChanged`; unknown/deleted id → 404.
- **UI.** Settings tab (`SettingsTab.tsx`) gains a two-step "Archive project"
  action; the global Admin tab (`IntegrationsTab.tsx`) gains an "Archived projects"
  section with a per-row **Restore** button.
- **Agent-native / chat (`cores/free/agent-settings/`).** `archive_project` /
  `restore_project` MCP tools (capability-gated, Telegram-confirmed) so "archive
  this project" / "restore the Foo project" work in chat; `list_projects` +
  `findLiveByName` exclude archived rows, `findArchivedByName` resolves the restore
  target.

## `neutron import-legacy` — the one-time vault migration (`open/legacy-import/`)

A ONE-TIME, ONE-DIRECTION cutover that lifts an existing the legacy harness vault (a markdown
knowledge base plus its MemoryStore brain) into a Neutron instance, so the owner
can stop running the old harness on the day he switches. It is not a sync and it
has no reverse: nothing here watches the vault, and a second run converges rather
than re-copying. Everything is driven from ONE CLI surface with sibling lane
subcommands — the lanes read different sources and fail in different ways, so
they are separate verbs rather than modes of one:

```
neutron import-legacy --help              # list the lanes
neutron import-legacy <lane> [flags]      # run one lane
neutron import-legacy <lane> --apply      # ...and actually write
neutron import-legacy all [--apply]       # every lane, in dependency order
```

**Dry run is the DEFAULT in every lane.** `--apply` is the verb that writes;
`--dry-run` is still accepted and now merely names the default. A dry run is not
a separate code path — each lane builds the same plan it would apply and prints
it, and the projects lane additionally opens the database `readonly: true,
create: false` so "it writes no instance data" is enforced by the connection.

**`all` without `--apply` previews EVERY lane.** The one thing a dry run DOES
write is the projects lane's PREVIEW MANIFEST —
`<NEUTRON_HOME>/migration/legacy-import-manifest.dry-run.json`, a migration
artifact, not instance data (nothing outside these lanes reads
`<NEUTRON_HOME>/migration/`). Without it the manifest-joining lanes could not be
previewed at all and `all` stopped at lane 3 of 5. It is a SEPARATE FILE from
the applied manifest and carries `"dry_run": true`, so a preview can neither be
consumed by an `--apply` (which reads only `legacy-import-manifest.json`, and
refuses any document flagged as a preview) nor CLOBBER the applied re-run ledger
— which matters because dry run is the default, so `import-legacy all` typed
after a real apply is the ordinary thing an operator does. A dry-run preview
reads the applied manifest when no preview exists, so previewing `documents`
after a real `projects --apply` still works.

**Stopping rules differ by verb.** `--apply` STOPS at the first lane that exits
non-zero (a later lane joins the earlier lane's manifest, and several lanes exit
1 deliberately to report an exclusion the operator must read before the next
lane compounds it in the database). A DRY RUN stops only at exit >= 2 — a
missing prerequisite or hard stop, where the later lanes genuinely cannot be
previewed. It walks PAST exit 1, because a preview has nothing to compound and a
real vault makes exit 1 the normal case (three dangling symlinks under
`Projects/neutron/coding-mirror/` are enough). The final banner names every lane
that reported exclusions and the returned code is the worst any lane produced,
so the signal is never swallowed.

**The lanes, in dependency order** (`open/legacy-import/lanes.ts` — one array,
which is also what `--help` renders and what `all` walks):

| Lane | Source | Destination |
|---|---|---|
| `projects` | `<vault>/Projects/` + `<vault>/Archive/` | project rows (Archive/ lands ARCHIVED, off the rail) **+ the manifest** |
| `entities` | `<vault>/entities/` | entity wiki pages, the legacy harness `## Timeline` sections converted to Neutron timeline rows |
| `documents` | markdown under `<vault>/Projects/` | per-project doc folders, byte-verified, directory structure preserved |
| `memory` | MemoryStore drawers + `~/.claude/projects/*/memory` + `<vault>/Memory/` + the MemoryStore knowledge graph | GBrain pages, KG triples as typed edges |
| `history` | Claude Code transcripts across every topic's own cwd, resolved via `<vault>/gateway/topic-map.json` | per-project `app_chat_messages` rows |
| `tasks` | `<vault>/tasks.md` | canonical `tasks` rows (migrations `0032` + `0037`), **priority polarity inverted** — the legacy harness is P0-highest, the destination is 3-highest |

**`projects` must run first, and the others JOIN its manifest.** It writes
`<NEUTRON_HOME>/migration/legacy-import-manifest.json` (`--apply`) or
`…-manifest.dry-run.json` (preview), mapping each vault directory to the project
id that was actually bound — or, on a preview, the id an apply WOULD bind,
resolved through the write path's own `resolveBindTarget` rather than by
re-slugifying the directory name. Later lanes read that file and refuse to
proceed without it; they deliberately do NOT re-derive ids by slugifying
directory names, because the projects lane rebinds a slug onto a pre-existing
row whenever one is already there, and a re-derived id would then file content
under a project that does not exist. The projects lane takes `--data-dir` like
every other lane, so `all --data-dir X` puts both halves of that join in one
home — and so does `history`, on BOTH its paths, because a dry run has to read
the manifest too.

**One reader, shared: `open/legacy-import/manifest.ts`.** `documents`, `history`
and `tasks` all join through it, so the rule lives in one place instead of once
per lane. That is not tidiness — `tasks` kept a private copy that knew only the
APPLIED manifest, so under `all --dry-run` it could not see the preview manifest
the projects lane had just written and stopped the walk at exit 2 (fixed
2026-07-29 by deleting `tasks/manifest.ts` and joining the shared reader). The
join key is `legacy_slug` (the vault `Projects/<dir>` name); the
destination is `project_id` (the id actually bound). `parseTopicMap` takes the
manifest index as a REQUIRED argument with no default — a defaulted empty map
would silently orphan every topic, so the join is a compile-time obligation
rather than a convention. The reader is also where the one-directional
preview/apply rule lives: an `--apply` reads ONLY the applied manifest (a
preview's ids are predictions), while a preview may read either.

**Exit codes** are uniform: `0` clean · `1` ran to completion but something was
excluded or failed verification · `2` bad usage, a missing prerequisite, or a
hard stop (a slug-identity violation, a duplicate id, a slug collision).

**How the memory lane reaches GBrain.** `open` may not import
`@neutronai/gbrain-memory` (the RA5 `memory-backend-swap-seam` depcruise rule),
so the lane is written against three injected seams — `PageStore`, `LinkWriter`,
`PageReader`. It gets all three from `buildGBrainMemory`
(`gateway/wiring/build-gbrain-memory.ts`), the one designated composition swap
point the live boot path also uses, so there is a single `gbrain serve` child,
one brain-init guard and one teardown. `MemoryStore` structurally satisfies
`PageStore`; `linkWriter` (`add_link`) and `pageReader` (`get_page`) are two
narrow one-method seams that builder exposes because `MemoryStore` carries no
edge surface and its `list_pages`-backed enumeration is hard-clamped by gbrain to
100 rows with no offset — which cannot prove a 1000-page import landed. Every
apply reads its pages back and reports the verification method it used.

### Known limitations — read these before trusting a run

- **`documents` does not converge changed content.** This is a cutover copy, not
  a sync: a source file edited in the vault AFTER it was imported lands as
  `occupied` and is SKIPPED. Only `--overwrite` pulls newer source text forward,
  and every file it replaces is listed individually in the run report.
- **`history` carries the messages but its SYNTHESIS step is unwired.** The lane
  produces the full-fidelity conversation stream and writes the verbatim rows;
  feeding that stream to the chunker/synthesis pipeline is separate work. So
  chat history is present and readable after an import, but nothing has been
  distilled from it.
- **`history` excludes a topic whose project is not in the manifest** rather than
  importing it. Since 2026-07-29 the lane JOINS the manifest like `documents`
  does (it previously re-derived ids as `basename(topic.project_path)`, which
  bound chat rows to an id that may not exist and reported success). A project
  topic whose vault slug has no manifest record is now an ORPHAN: its messages
  are dropped, the topic is named in the report with the count it cost, and the
  run exits 1. That is an exclusion rather than a hard stop so one stale
  `topic-map.json` entry cannot block the whole corpus — but it IS real
  conversation not imported, so reconcile it (re-run `projects`) rather than
  ignoring the exit code. Ryan's vault produces 0 orphans.
- **`documents` lists every ARCHIVED project as "source dir gone".** The
  manifest carries `Archive/` records too, but this lane's source root is
  `<vault>/Projects/`, so all 19 of Ryan's archived projects show up under
  MANIFEST PROJECTS WHOSE SOURCE DIR IS GONE. Cosmetic noise in the report, not
  a data problem — the lane could filter on `source_kind: 'archived'`.
- **`history` needs the vault's `gateway/topic-map.json`** and exits 2 without it.
  That is deliberate: the transcripts are NOT under the vault — each topic runs
  its session in its own working directory, so the map is the only thing that
  resolves the ~21 transcript roots. An earlier assumption that one directory
  held them all covered 11% of the corpus.
- **`tasks` needs the vault's `tasks.md`** and exits 2 without it — same posture
  as `history` and the topic map: a missing prerequisite fails loudly rather than
  importing nothing. It also EXCLUDES rather than guesses: a `[project:<slug>]`
  tag with no manifest record is an orphan (Ryan's vault: 11 tasks tagged
  `[project:gateway]`, a topic with no vault project directory), and an empty
  title is excluded too. Both are listed with their verbatim source line and the
  run exits 1. Two further costs are stated rather than hidden: the row id is
  `sha256(title span)`, so editing a task's WORDS in the legacy harness creates a SECOND row
  on a re-run, and the legacy harness's `Blocked` / `Waiting` / `This Week` sections have no
  destination state (`tasks.status` is exactly `open|done|cancelled`) so they
  land as `open` with the section dropped — reported as a coercion.
- **Attachments are not carried.** Only markdown moves. Images, PDFs and other
  binaries referenced from a note stay in the vault, and the link in the imported
  page will not resolve.
- **The `memory` lane's two SQLite sources must be a SNAPSHOT.** `--chroma-db`
  and `--kg-db` have no defaults on purpose — pointing them at a live
  `~/.memory-store/` file would read a database being written underneath the run.
  Omitted, those sources are silently absent from the plan, and the run says so.
- **A resumed memory run must reuse the original timestamp.** Every page is
  stamped `legacy_imported_at`; the checkpoint ledger compares content hashes, so
  a resume with a fresh timestamp re-hashes every already-written page as
  changed. Pass `--imported-at` with the value echoed in the manifest.
- **Embedding depends on the host.** The measured 7.8 pages/s was recorded with
  no embedder active. A brain with a live embedder embeds on write and is slower.

**Adding a lane:** write `open/legacy-import/<lane>/cli.ts` exporting
`main(argv, env?, write?): Promise<number>` (dry by default, `--apply` writes,
the exit codes above), then add ONE `ImportLane` entry to
`open/legacy-import/lanes.ts` at its dependency position. Nothing else registers a
lane — `bin/neutron` forwards argv verbatim and the dispatcher reads only that
array — and `open/__tests__/legacy-import-cli-registry.test.ts` fails if an entry
is dropped or renamed, which is the guard whose absence let the memory lane ship
with no entry point at all.

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
prioritize cron is wired in `gateway/composition/build-core-modules.ts` gated
SOLELY by `tasks.enable_task_prioritize_cron` (it registers whenever that is
true); `tasks.task_prioritizer.llm` is an OPTIONAL dependency, not a second gate —
registering with a null llm is safe, the handler runs the deterministic ranking
until a credential exists.

### What the composer actually turns on (ISSUES #439 / #440)

Everything above is gated on a `composition.tasks.*` field, and until 2026-08 the
only production composer set NONE of them — so five declared capabilities shipped
as guaranteed no-ops while `tasks-input.ts` claimed "production wires all three."
`open/composer.ts` now sets the whole block, and each entry is asserted against
the composer's REAL output in `open/__tests__/open-tasks-wiring.test.ts` (a
hand-built config literal in a test proves the gate, never the producer):

| Field | State | Effect |
|---|---|---|
| `store` | always | THE canonical `TaskStore` — see below |
| `enable_focus_score_cron` | always | `tasks.focus_score_recompute`, 4h |
| `enable_task_prioritize_cron` + `task_prioritizer.llm` | always (llm may be null) | `tasks.prioritize_llm`, 6h; deterministic when llm-less |
| `enable_reminder_link` | always | due-dated tasks get a reminder |
| `enable_nudge_engine_cron` + `nudge_engine` | only with an LLM | daily `current_focus_pick` |
| `projection` | always | STATUS.md / ACTIONS.md under `<owner_home>/Projects/<id>/` |

**ONE `TaskStore` per box.** A `TaskStore` carries the mutation-subscriber list
that `tasksModule.init` attaches the reminder-link and projection listeners to,
so a surface holding a *different* instance over the same db writes the row and
fires nothing. Open used to build three — the composition fallback, one for the
app HTTP surface, one inside the Tasks Core adapter. `open/composer.ts` now
builds exactly one and threads it into all three (`composition.tasks.store`,
`createAppTasksSurface`, and `mountOpenCores({ canonicalTaskStore })` →
`buildCoresBackendFactories`). The store-identity tests drive a write through the
HTTP surface and through the Core adapter and assert the canonical store's
subscriber fired — a "the row is in the table" assertion cannot tell the two
apart.

**The task → reminder link** (`tasks/reminder-link.ts`) creates one reminder per
due-dated task on the ordinary `app-project:<id>` topic (so the existing tick
loop delivers it and the Reminders tab lists it), reschedules it in place when
the date moves, rewrites its body when the task is renamed
(`ReminderStore.retitle`), restores it when a completed task is re-opened, and
cancels it on complete / cancel / delete / due-date-cleared. It refuses to
schedule anything already in the past (`MAX_PAST_DUE_DRIFT_SECONDS`, 60 s,
matching the app reminders surface's floor) — the onboarding history-import
seeder bulk-creates tasks from LLM-proposed dates, and past-dated ones would each
be due on write. Overdue-ness stays the focus score's job.

**The projection writer's failures are no longer silent.** Its default log sink
is a no-op; `build-core-modules.ts` now supplies one that warns
`tasks_projection_write_failed`, so an unwritable `Projects/` dir surfaces.

## Reminders — cadence + fire-time composition (`reminders/`)

Instance-scoped reminder engine (`@neutronai/reminders`), backed by the
per-project `reminders` table. Three parts:

- **Store** (`reminders/store.ts`) — CRUD over the table. A reminder is
  one-shot, or recurring via ONE of two cadence representations (mutually
  exclusive, `isRecurring()` is the single predicate):
  - a COARSE `recurrence` label (`weekly` / `monthly` / `occasional`) with
    fixed-delta rescheduling; or
  - a `recurrence_spec` — a FAITHFUL 5-field cron expression (migration 0093)
    for exact wall-clock cadences (`0 9 * * *`, `0 9 * * 1-5`, `0 9 7 2 *`,
    `0 */6 * * *`). This is the M2-cutover parity target: real cron reminders
    migrate verbatim.
- **Tick loop** (`reminders/tick.ts`) — a single-flight `setInterval` that
  claims each due row BEFORE dispatch (crash-safe at-most-once, #319) and
  advances it. Both cadence kinds resolve through ONE `computeNextFire(reminder,
  now, tz)`: a cron spec computes the next DST-correct wall-clock instant
  strictly after now (via `@neutronai/cron`'s `cron-standard.ts` evaluator — the
  classic-crontab sibling of the systemd-`OnCalendar` parser in `calendar.ts`,
  with Vixie dom/dow OR semantics and spring-forward gap-skip); a coarse label
  uses the fixed delta. A corrupt cron fires once then retires so it can't wedge
  the loop.
  - **Which clock "9pm" means (ISSUES #40).** A cron cadence is resolved in the
    OWNER's zone, read per fire from `instance_metadata.timezone` via
    `readOwnerTimezone` — the same source and the same resolve-at-invocation
    contract the nudge engine uses, so a zone reported after boot applies on the
    next tick without a restart. The composition passes `resolve_time_zone` and
    validates the stored value with `isValidIanaTimezone`, because an
    unconstructable zone would make `nextCronFire` throw and the tick would
    retire the row as an uncomputable cadence — a bad zone must cost an hour,
    never the reminder. There is deliberately **no host-zone fallback**: the loop
    previously defaulted to `hostTimeZone()`, so on a UTC server every recurring
    reminder fired at its stored hour in UTC (a `0 21 * * *` evening cadence
    arriving mid-afternoon for an owner in the Americas) while raising no error.
    When the owner's zone is not known yet the loop uses the explicit
    `REMINDER_FALLBACK_TIME_ZONE` (`UTC`) and logs it — a stable, machine-
    independent default beats one that changes if the instance moves boxes.
    Every client reports its IANA zone on connect, so a live instance leaves the
    unknown state on first connect.
  - **Existing rows need no migration.** A `recurrence_spec` stores a bare
    wall-clock expression with no zone, and it always MEANT the owner's clock —
    only the reading was wrong, so the stored specs are already correct. The
    derived `fire_at` column, however, still holds the next instant computed
    under the old host-zone reading, so each already-pending recurring row fires
    ONE more time at the old (wrong) hour; `advanceRecurrence` then recomputes in
    the owner's zone and every later occurrence is correct. Nothing is dropped or
    rewritten. `fire_at` is deliberately NOT backfilled at boot: it doubles as
    the owner's manual reschedule/snooze slot (see `revertRecurrenceAdvance`), so
    a boot-time recompute would clobber a deliberate one-off move. An owner who
    doesn't want to wait out a long cadence can reschedule or recreate that
    reminder to correct it immediately.
- **Dispatcher** (`reminders/dispatcher.ts` + `message-shape.ts`) — the
  fire-time composer. The stored `message` is classified into one of three
  shapes (**literal / smart-wrap `[smart]` / pattern-template `PATTERN:`**);
  when an LLM substrate is wired it gathers live context
  (`buildStatusMdContextSource`) and composes a fresh, warm nudge on a
  Haiku-class turn, degrading to the shape's literal fallback on any failure so
  a reminder ALWAYS delivers. This is orthogonal to cadence — cron and coarse
  rows compose identically, so a migrated **smart** reminder still produces a
  context-aware message at fire.

The Reminders Core (`cores/free/reminders/`) is the product-surface adapter over
this store: its `reminders_create` tool accepts an optional `recurrence` label
OR `recurrence_spec` cron (validated via `isValidCron`), and `snooze` / `update`
preserve a reminder's cadence across the atomic cancel+create. Its manifest also
contributes the **Reminders tab** — the `app_tab` ui_component whose
`props_schema` consts (`/projects/<project_id>/reminders`, label, emoji, order
40) are what `gateway/http/app-tabs-surface.ts` turns into a descriptor. That
`props_schema` was missing until 2026-08, and the resolver SKIPS an `app_tab`
with no declared `path`, so the tab survived only in the mobile pre-fetch
placeholder and vanished the moment `/tabs` answered.

**Push delivery** (`gateway/push/`). A fired reminder also reaches the owner's
registered devices. `open/composer.ts` builds ONE `DevicePushTokenStore` and
hands it to both halves — `/api/app/devices/{register,unregister}` (what the app
calls on every sign-in/sign-out) and `createPushDispatcher`, supplied as
`composition.push_dispatcher` and attached by `build-core-modules.ts` to
`ReminderTickLoop.on_fired`. Three properties make it safe to run unconditionally:
it fires only AFTER a successful nudge dispatch, so push never announces a
reminder the owner was not already being told about; with zero registered tokens
`dispatch` returns before issuing any HTTP request, which is the state of every
fresh install; and a ticket Expo marks `DeviceNotRegistered` DELETES that token
row, so a dead device is retried once rather than on every reminder forever
(other ticket errors — rate limits, credential problems — never prune). Failures
are caught inside the tick, so an unreachable Expo cannot stop a reminder from
being marked fired. `EXPO_ACCESS_TOKEN` is optional; anonymous sends work and are
merely rate-limited.

## Ritual executor — approval-gated code rituals (`reminders/`)

A ritual is a scheduled reminder whose fire runs a CODE turn (a Claude Code
substrate) instead of composing a text nudge — the legacy harness's "scheduled agent" parity.
It reuses the reminder table + tick loop for scheduling; a due row with a
non-null `ritual_id` routes to the executor branch. The whole surface is
approval-gated: nothing fires unless the OWNER has explicitly approved that exact
ritual content in chat.

- **Ritual defs + registry** (`reminders/rituals.ts`). A `RitualDef` (interface
  at `reminders/rituals.ts:131`) declares exactly SIX fields — `id`, a
  `description` (the human capability line rendered in the approval prompt), a
  `scope` (`'instance' | 'project'`), a `tool_surface`, an `egress` class
  (`'none' | 'web'`), and a `silent` flag. It DELIBERATELY carries no prompt,
  cadence, tier, or timeout field (module header §34-36): the self-contained
  prompt bytes live in the SEPARATE `rituals/<id>.md` file (derived from the
  charset-guarded `id`, never a def field); the cadence lives on the scheduled
  reminder row (`ritualCadenceString`, `reminders/ritual-approval.ts:109`); and
  the model TIER (`RITUAL_MODEL_TIER = 'best'`, `reminders/rituals.ts:55`) and
  spawn TIMEOUT (`RITUAL_TIMEOUT_MS = 45m`, `reminders/rituals.ts:47`) are module
  CONSTANTS shared by every ritual, not per-def fields. (The content-hash below
  binds all six of prompt‖surface‖scope‖cadence‖tier‖timeout at approval time by
  drawing prompt from the file, cadence from the row, and tier/timeout from the
  constants — so the HASH covers more than the def does.)
  `createRitualRegistry` (`reminders/rituals.ts:278`) roots defs at
  `<owner_home>/rituals/`. The fire-time gate is the async `validateRitualFire`
  (`reminders/rituals.ts:374`), which takes a REQUIRED `RitualApprovalCheck` seam
  (`reminders/rituals.ts:341`) and FAILS CLOSED — an unknown id, a missing def, a
  DB error, or an unapproved def all return a durable SKIP verdict, never a fire.
- **Content-hash approval binding** (`reminders/ritual-approval.ts`).
  `computeRitualContentHash` (`reminders/ritual-approval.ts:89`) is a sha256 over
  prompt‖surface‖scope‖cadence‖tier‖timeout; `createRitualApprovalCheck`
  (`reminders/ritual-approval.ts:240`) recomputes that hash from the LIVE file
  bytes on EVERY fire and matches it against the approved-grant hash. An owner
  editing the ritual file, or an agent widening its surface/cadence, changes the
  hash and silently DROPS approval by design — a widened ritual must be
  re-approved.
- **Fire path — ONE path, the same one a plain reminder takes (ISSUES #504, SPEC
  Decisions Log 2026-08-05).** There is no ritual branch in the tick and no ritual
  executor. `reminders/tick.ts` hands EVERY due row to `dispatcher.dispatch`, and
  `reminders/dispatcher.ts` asks the ritual fire PLANNER
  (`reminders/ritual-fire.ts`) one question — what does this row compose from, and
  what must be recorded about it? A `nudge` answer composes the row's stored
  message; a `skipped` answer (the fail-closed verdict) writes a durable
  `code_ritual_runs` 'skipped' row and posts NOTHING; a `fire` answer writes a
  durable `'running'` row and composes the APPROVED PROMPT — on the owner's own
  warm `cc-agent-*` session, through the same `llm.compose` call and the same
  `deliver()` outbound a nudge uses — then settles the ledger `finished`/`failed`.
  A `silent` ritual skips the success post; a failure posts one one-line notice and
  escalates once per 3-consecutive-failure streak. `reapOrphanRitualRuns` still
  reaps prior-boot orphaned `'running'` rows to `'crashed'` at boot and prunes runs
  after 30 days.
- **WHY the lane was deleted, and what replaced its security.** A ritual used to
  spawn a fresh ephemeral `cc-ritual-*` REPL that wired NO tool bridge — so the
  morning brief could not read the owner's calendar: granting
  `mcp__neutron__calendar_list` validated and then failed, because that MCP server
  did not exist inside the sandbox. The lane built to make rituals SAFE was the lane
  that made them USELESS. The owner rejected it outright (*"Rituals shouldn't be a
  special case in a private REPL… The morning brief should just be a regular
  reminder in the general chat, with access to everything general has access to"*).
  Deleted with it: `reminders/ritual-executor.ts`, `reminders/ritual-retry.ts`,
  `reminders/ritual-agent-base.md` + `prompt-path.ts`, `makeRitualSubstrate`,
  `PROFILE_RITUAL`, and the separate `agent_kind:'ritual'` concurrency lane
  (`MAX_CONCURRENT_RITUALS`). SURVIVING and now carrying the whole model: the
  APPROVAL GATE, the content-hash binding re-checked at every fire, fail-closed
  `validateRitualFire`, `RITUAL_ID_RE`, the non-empty-`tool_surface` pin (#361), and
  the `code_ritual_runs` ledger.
- **⚠️ `tool_surface` IS AN APPROVAL DECLARATION, NOT A RUNTIME GRANT** — a
  mechanical consequence, not a preference. A ritual composes on the owner's warm
  pooled session, whose `--tools` allow-list is fixed at SPAWN; the persistent-REPL
  reuse guard EVICTS AND RESPAWNS a warm child whose requested surface differs
  (`runtime/adapters/claude-code/persistent/spawn.ts:824,837`). Passing a per-ritual
  surface would not restrict the ritual — it would destroy the owner's live chat
  REPL on every fire. So fired reminders present the LIVE-CHAT surface
  (`LIVE_AGENT_TOOL_NAMES`, threaded by the composer as `tool_names`), and the
  accepted consequence — signed off with the decision — is that **a ritual firing
  into the warm session can do anything that session can, including `Bash`. The
  approval gate is the only boundary.** The bundled defs' `description` strings were
  rewritten accordingly: they no longer promise "no shell, no writes, no network",
  because that string is rendered verbatim into the approval prompt and would have
  been the gate lying to the owner at the moment he decides.
- **Re-approval when the hash moves.** Anything that changes the content hash
  correctly drops approval — but nothing used to ask for it again, so the ritual went
  silent (`enable()` refuses once `<id>.def.json` exists, and the boot sweep treated
  that file as "done"). `bundled-ritual-enable.ts` now consults `status()` and calls
  the new `service.reapprove(id)` when the live hash has NO grant, leaving `pending`
  alone and `denied` denied. This closes a pre-existing silent death (an owner
  editing `<id>.md`) and is required by #504 itself, which changed the hashed
  `RITUAL_TIMEOUT_MS` from 45 min to 10 min — a ritual is now one AWAITED turn inside
  a SINGLE-FLIGHT tick, so its budget is also the longest it can stall every other
  due reminder.
- **Write-containment gate — STAY GATED (overturn 1).** The T5 spike that tried
  to prove per-session `settings.json` deny fails CLOSED with the substrate
  auto-approver disabled returned an UNPROVABLE verdict (2026-07-21: with
  `skip_permissions:false` + a `permissions` block, the dev-channel MCP bound in
  only 1/6 real-PTY runs and the bound run WEDGED on an interactive prompt — no
  clean fail-closed; recorded at
  `docs/plans/executor-mode-reminders-2026-07-20.md:254-278`). Consequence: any
  ritual whose `tool_surface` grants a `GATED_WRITE_TOOLS` member (`Bash`,
  `Write`, `Edit`, `MultiEdit`, `NotebookEdit` — `reminders/rituals.ts:106`)
  STAYS GATED at fire time via a `gated_tool_surface` SKIP in `validateRitualFire`
  until the OS-level sandbox sprint ships. Read-only rituals (surface within
  `Read`/`Glob`/`Grep`, egress `'none'`) ship now under Layer 1 (the `--tools`
  default-deny). Per overturn 1, this is APPROVAL-not-exclusion: a Bash-based
  the legacy harness ritual still ports AS-IS with `requires_approval` — the Bash surface is
  not excluded from the format, it is held at the fire-time gate until sandboxing
  makes the run containable.
- **Agent-callable registration + in-chat approval (overturn 3)**
  (`reminders/ritual-registration.ts`). An agent proposes a ritual through the
  reminders-Core `rituals_propose` / `rituals_enable` / `rituals_status` MCP
  tools; the security property is carried by the approval GATE, and the approval
  RENDERING IS the mitigation. `rituals_propose` creates a BRAND-NEW ritual (write
  the `<id>.md`+`<id>.def.json`, register, request approval); `rituals_enable`
  (`RitualRegistrationService.enable`) gives an ALREADY-REGISTERED ritual — a
  bundled example or a persisted def — a schedule + approval (it reads the
  seeded/owner `<id>.md` on disk, writes ONLY the `<id>.def.json`, requests the
  same approval). Both funnel through one shared `requestApprovalAndEmit` tail, so
  the approval prompt, content-hash binding, and full rollback are identical.
  `renderRitualApprovalBody` (`reminders/ritual-registration.ts:301`)
  emits a code-rendered, run-length-hardened fenced block that shows the FULL
  prompt text, CAPABILITY bullets (not bare tool names — a Bash/write capability
  is labelled "CURRENTLY BLOCKED at fire time"), the scope root, the cadence, and
  an unattended-runtime line. Approval requires an explicit affirmative act: the
  exact opaque `rap:` token from the persisted option set, OWNER-only, no
  self-approval; anything else the owner types is inert.
  `handleOwnerButtonAnswer` (`reminders/ritual-registration.ts:611`) captures at
  turn-start against the persisted options and schedules the reminder row ONLY on
  an approved grant whose content hash still matches the live bytes. There is no
  register-and-fire in one turn, and surface/cadence widening drops approval via
  the content hash.
- **Bundled defs** (`reminders/bundled-rituals.ts`). `morning-brief`,
  `evening-wrap`, and `kaizen` templates ship in-repo, are seeded
  copy-if-absent into `<owner_home>/rituals/` (`seedBundledRituals`,
  `reminders/bundled-rituals.ts` — an owner-edited file is never clobbered),
  and register UNAPPROVED on boot (`registerBundledRituals`) inside the composer's
  `init_ritual_planner` install hook. A bundled ritual has a
  seeded `<id>.md` but NO `<id>.def.json`, so it starts with no schedule and no
  approval — it does nothing until the owner ENABLES it. `rituals_propose` cannot
  enable a bundled id (its `<id>.md` already exists → `exists_on_disk`); the owner
  (via the agent) uses `rituals_enable(id, schedule)`, which writes the missing
  `<id>.def.json` and requests the approval prompt. Approving that prompt schedules
  the reminder row and the ritual begins firing on its cadence.
- **`kaizen` — the weekly continuous-improvement pass** (`reminders/rituals/kaizen.md`).
  Ported from the legacy harness 2026-08-01, replacing `daily-delta` (dropped by the
  owner: its job was proving the system still worked, which the reachability gates now
  do directly). Kaizen exists for ONE judgement the rest of the system cannot make —
  *this has been corrected four times, so the bug is in the system, not in the
  instance.* On its cadence it reads `corrections/corrections-log.md` (the spine),
  `diary/*.md`, `persona/SOUL.md` (where a missing rule would live),
  `Projects/*/ACTIONS.md` + `STATUS.md`, the sibling `rituals/*.md`,
  `logs/server.log` (grepped, never read whole) and
  `diagnostics/client-reports.jsonl`, groups the week's corrections by LESSON rather
  than wording, labels any lesson seen 3+ times SYSTEMIC, and ends with three
  concrete changes each naming the file that would change.
  - **It PROPOSES; it cannot act.** `GATED_WRITE_TOOLS` refuses Write/Edit at fire
    time (`reminders/rituals.ts`), so the legacy ritual's "auto-file the top 3 into
    an issues list" half does NOT port — and Open has no owner-side issues file to
    file into (`SPEC.md`: the defect tracker is GitHub Issues). The owner acts on
    the report.
  - **It is the only bundled def with `egress: 'web'`**, for one narrow ecosystem
    scan. That costs a SECOND approval prompt by design
    (`reminders/ritual-registration.ts` emits a separate `ritual-egress:<id>` grant;
    approving the content never implies approving egress), and it is the first
    shipped def to exercise that path. Read-broadly + network-reach in one agent is
    an exfiltration shape, so the template forbids putting anything read on disk
    into a query and forbids opening `.env` / `.secrets` / `*.db` at all.
  - **The report reaches the owner or the ritual has failed.** `silent: false`, so
    the final reply posts through `ReminderOutbound` →
    `deliver(topic, { durability: 'reply' })` (`gateway/proactive/reminder-outbound.ts`)
    as a durable history row on the owner's chat topic — present on the next
    hydration even though it fires from a timer with no socket open. A weekly report
    that settled into a log would be the Skill Forge notifier defect (#51) again, so
    the unit test asserts the POST, not the flag.
  - **Two inputs the legacy ritual had do not exist here**, and kaizen is written to
    do without them rather than pretend: reminder/ritual FIRE HISTORY is SQLite-only
    (`code_ritual_runs`, no file surface), so kaizen can see which rituals exist by
    globbing `rituals/*.md` but not whether they ran; and live session transcripts
    are SQLite-only, so it reasons from the corrections log and diary instead.

## Owner-approved host deploy — request → approve → execute (`open/host-deploy.ts`)

**The instance holds no deploy capability. It holds the ability to ASK.** A request
crosses the privilege boundary; a capability never does. Nothing here grants the
instance deploy rights, host filesystem access, or a privileged credential — the
only thing that changes is that a deploy can be put in front of the owner, with
the actual commit list attached, and performed by his explicit act.

The problem it closes: work merged into Open did not reach the box the owner
actually uses, and **nothing on that box deploys on its own** — its only timers are
a lane sweeper, a credential rotator, a CLI update doctor and a backup. A deploy
happens when a human runs one. From the inside that total absence is
indistinguishable from "deploys land on their own and just lag".

**The flow, in three steps.**

1. **REQUEST** — the agent calls `host_deploy_request` (`gateway/wiring/host-deploy-tool.ts`,
   registered into the same `neutron` tools registry the tools-bridge advertises, so
   the REPL sees `mcp__neutron__host_deploy_request`). The service
   (`open/host-deploy.ts`) resolves, READ-ONLY, what would be deployed: the sha the
   host runs now (`HEAD`), the target sha for the named ref, and the commits between
   them (`open/host-deploy-runtime.ts`, over the shared `gateway/git/git-exec.ts`
   wrapper — no fetch, no checkout, no write). It then mints a `prompt-user`
   `tool_approvals` row (`tools/approval.ts`, migration 0004) and emits a
   CODE-rendered Approve/Deny prompt through the SAME durable `deliver` seam ritual
   approvals ride. It returns `pending_approval`. **Nothing is dispatched.**
2. **APPROVE** — the owner taps. The tap is captured deterministically at turn start
   by the live-turn approval seam (`gateway/wiring/build-live-agent-turn.ts`), which
   the composer chains across the ritual handler and this one; each returns null for
   a token that is not its own (`rap:` vs `hdp:`). Eligibility is an EXACT opaque
   token that was a real offered button on a recent prompt, from the owner's user id.
   Silence, a timeout, "yes", a paraphrase and any non-owner speaker — the agent
   included — can never flip the row, so **an agent can never approve its own
   request**.
3. **EXECUTE** — the target ref is RE-RESOLVED. If it moved, the approval is STALE:
   it is killed, nothing deploys, and the owner is told the new sha and asked again.
   Otherwise the row is CLAIMED — `respondApproval` (`tools/approval.ts`) does its
   `UPDATE ... WHERE status='pending'` and reports the affected-row count in one
   transaction, and only the caller it tells `true` may act. ONE authenticated call
   then goes to the configured control-plane endpoint. The outcome — landed, or
   refused, or unreachable — posts back to the same chat.

**The claim, not the check, is the gate.** Everything in step 3 before the claim
happens across `await`s, so two taps arriving in the same tick both see a pending
row and both pass the stale check. Gating the dispatch on the affected-row count is
what makes "exactly one deploy" true: two Approves dispatch once, and an Approve
that interleaves behind a Deny dispatches nothing. A check that a row *was* pending
is not a claim that this caller *made it* stop being pending.

**A grant has a lifetime.** A pending approval older than five minutes is refused on
the ANSWER, against the row's own `requested_at` — not left to a sweep, because
`ApprovalManager.expireStale()` has no production caller on this box. A documented
window that nothing enforces is not a window.

**The approval renders the commit list, and that is the security.** The owner is the
only gate, so the thing he is gating has to be legible in the message he taps: the
current pin, the target sha, and every commit between them (capped at 40 rendered,
with the true remainder counted — never silently truncated). An approval whose
content the approver cannot see is a rubber stamp with extra steps. Commit subjects
are stripped of bidi / zero-width / C0 characters — including CR and LF, the
line-overwrite and line-forging payloads — and wrapped in a backtick fence longer
than any run inside them, because a commit subject is chosen by whoever lands the
commit and the button body is Markdown-rendered.

A ROLLBACK is rendered the same way, from the other direction: when no commits sit
between the current pin and the target, the approval itemizes the commits the host
is running now that would be TAKEN AWAY. The content of a rollback is what it
removes, and an empty block above a warning is the same rubber stamp in reverse.

**The approval binds to ONE sha.** Without the re-resolve, "approve" would quietly
mean "deploy whatever is newest when this executes" — a different and unbounded
permission.

**No control plane configured → VISIBLE and DISABLED, with the reason.** A
self-hoster has no endpoint to call. Both tools still register and still answer:
`host_deploy_status` reports `enabled:false` and points to Settings → Integrations,
where the owner can add the generic names `host_deploy_url` and `host_deploy_token`.
Those rows exist only when an owner adds them. No default endpoint is ever
fabricated. An option that silently disappears is how a missing capability stays
invisible for weeks — the rule the model-tier pane follows.

**The endpoint and credential resolve from `ProjectCredentialStore` at CALL time**,
never captured at composition time (a credential read at composition time is a
credential that is never there — Decisions Log 2026-08-07). The URL uses the same
named-value store because that avoids adding a product-specific setting slot; it is
ordinary configuration, not a secret, and remains visible in useful diagnostics.
The token never enters a prompt, log line or chat message: it rides an `Authorization`
header and everything the control plane says is run through
`scrubHostDeploySecrets` before it is shown or logged — **scrubbed first, then
truncated**, because the scrubber matches the whole secret and a value cut by the
length cap would otherwise leave a real prefix of itself behind. A credential too
short for the scrubber to redact safely is refused as configuration rather than
accepted and printed: one constant governs both ends.

**A refused contract gate is a NORMAL outcome.** The host saying "the deploy window
is closed" reads as one sentence in chat, not as a crash.

## Proactive messaging — idle-nudge sweep (`gateway/proactive/`)

The owner-facing proactive layer (the legacy harness parity). It was built + tested
early but stayed DEAD until P1-4 because it registers only when `tasks.proactive`
is set — and the Open composer never set it. It now ships ON (no feature flag);
`open/composer.ts` wires `tasks.proactive`, including `listIdleTopics` since
2026-07-30.

- **THERE IS NO SECOND MORNING BRIEF HERE ANY MORE (ISSUES #504).**
  `gateway/proactive/morning-brief.ts` was DELETED, along with its cron
  (`proactive.morning_brief`), its `tasks.proactive` config keys (`sources`,
  `composeBrief`, `brief_hour`, `brief_interval_ms`) and its test. It was a
  provider-driven composer whose `calendarToday`, `entityDeltas` and `projectStatus`
  slots were supplied by **nothing in production** — only by its own test — which is
  the persona-gen shape and is exactly why the brief it posted had to say "I couldn't
  check your calendar". **The morning brief is the `morning-brief` RITUAL**, fired as
  an ordinary reminder onto the owner's own session (see the rituals section above),
  which is the only version that can actually reach the calendar Core. The
  `proactive_brief_log` table and `ProactiveStateStore.hasBriefForDay` /
  `recordBriefForDay` remain in place unused rather than being migrated away.
  (Unrelated, despite the shared filename: `onboarding/overnight/morning-brief.ts`
  is the OVERNIGHT-WORK reporter — it reports Trident runs that finished overnight,
  is fully wired, and is untouched.)
- **Durable web sink** (`button-store-sink.ts`). Open's topics are `app_socket`
  and proactive posts fire from a timer, so they route through
  `buildButtonStoreProactiveSink` — an `OutboundSink` that persists an INERT,
  already-resolved agent history turn (`ButtonStore.persistInertAgentTurn`, so a
  passive scheduled post never becomes the topic's active prompt) + best-effort
  live-push, the same durable path fired reminders use — NOT the core
  `ChannelRouter`'s live-only `AppWsAdapter` (which would drop a post with no
  open socket). `tasks.proactive.sink` overrides the router; absent → router
  (Telegram instances).
- **Idle-nudge sweep** (`idle-nudge-sweep.ts`) — **ACTIVE since 2026-07-30.** Per
  tick it takes the idle candidate(s) supplied by `listIdleTopics`, reads the
  day's ranker pick (`current_focus_pick`) and posts ONE highest-leverage next
  action through three gates: idle threshold (default 4h) → dedupe (never
  re-nudge the same task until the owner returns) → the **dual-rating ≥7 quality
  gate** (`evaluateQualityGate` + the `rateNudge` LLM seam,
  `buildLlmNudgeRater`): a candidate is rated 1–10 on leverage + gratitude and
  only posts when BOTH ≥7; a null/abstain rating skips (`low_quality`).
- **Idle-topic enumeration** (`idle-topic-enumeration.ts`) — the seam that kept
  the sweep switched off, now correct. `buildOwnerIdleTopicEnumerator` returns
  **exactly ONE** candidate (the owner's General app-ws topic, the same target as
  the brief) — not a fan-out, because the P6 ranker writes one
  `current_focus_pick` per instance per day, so per-topic candidates would post
  the same thought into every topic. Its `last_activity_ms` is the **maximum
  genuine user activity across BOTH topic roots**, `web:<owner>` and
  `app:<owner>`. Two defects had to be fixed for that to be expressible:
  - `ButtonStore.listTopicsByUser` was single-root, so the sweep was blind to
    whichever client the owner was not using. It now takes `user_id_prefix` as a
    string **or an array of roots**, unioned in one grouped scan (`project_id` is
    attributed by longest-matching root).
  - The activity watermark polluted itself. The nudge posts via
    `persistInertAgentTurn` into `button_prompts` — the table the watermark reads
    — so against `MAX(created_at)` the sweep saw its own bubble as "the user came
    back" and re-nudged every idle cycle forever. `listTopicsByUser` now returns
    **two** watermarks: `last_created_at` (every row; the SIDEBAR's ordering key,
    unchanged) and **`last_user_activity_at`** — `resolved_at` on rows whose
    `resolution_speaker_user_id` is a real person, excluding the
    `SYSTEM_SPEAKER_USER_ID` (`__system__`) sentinel that `persistInertAgentTurn`
    and `sweepExpired`'s `__timeout__` both stamp. Only a human can move it.
  Non-repetition is pinned by `gateway/proactive/__tests__/idle-nudge-no-repeat.test.ts`
  (four idle cycles → exactly one nudge; real user activity re-arms it; both
  namespaces observed), mutation-tested in both directions.
- **The daily nudge PRODUCER** (`gateway/tasks/p6/nudge-engine.ts`) — the sweep
  above consumes `current_focus_pick`, and that table's only non-test writer is
  the P6.1 nudge cron. `open/composer.ts` sets `tasks.enable_nudge_engine_cron`
  + `tasks.nudge_engine.llm` (the same warm `cc-llm` `proactiveLlm` the brief
  composer and nudge rater use), so the producer runs. The flag is set **only
  when that llm resolves** — that is a dependency, not a feature flag: an
  llm-less tick still runs the staleness pass (decaying focus scores) and then
  bails without writing a pick, which is strictly worse than not registering.
  Between 2026-06-27 and this fix the flag was unset while the sweep shipped ON,
  so the sweep returned `no_pick` on every tick and could never post.

### Which clock the daily rhythm runs on

Every scheduled owner-facing surface resolves **the OWNER's** zone, not the
host's — the brief's hour gate and day key, the sweep's day key (which is also
the key `readTodayPick` looks the ranker's pick up by), the P6 nudge pick's day,
and recurring reminders.

The single source is `instance_metadata.timezone` (written by the app-ws client
on connect — see § app-ws timezone reporting), read through `readOwnerTimezone`
(`gateway/storage/owner-metadata.ts`). `build-core-modules.ts` wires it into
`MorningBriefDeps.resolveTimezone` / `IdleNudgeSweepDeps.resolveTimezone` /
`NudgeEngineHandlerDeps.resolveTimezone`, and the cron handlers call it **per
fire**, keyed on the dispatched `ctx.owner_slug`. Per-fire is load-bearing twice:
a fresh install has no `instance_metadata` row until the first client connects
(a boot-time read would freeze the wrong zone forever), and a mid-run zone change
takes effect on the next tick without a restart.

Precedence: `resolveTimezone(owner_slug)` → the static `tz` → `DEFAULT_OWNER_TIMEZONE`.
The static `tz` is the host's zone (`resolveLocalTimezone`, `local-timezone.ts`:
`process.env.TZ` → the runtime's `Intl` zone → a defensive floor), threaded by
`open/composer.ts` as `tasks.proactive.timezone`. It is kept deliberately: on a
self-hosted laptop install the host IS the owner's machine, and there the host
zone is the right answer. It became the WRONG answer only once the same code was
hosted — a hosted box runs `Etc/UTC` while the owner lives in Pacific, so the 7am
brief fired at midnight local and the sweep's pick lookup missed for the hours the
offset spans. **"Local" is a property of the deployment, not of the code.** Pinned
by `gateway/__tests__/proactive-owner-timezone-wiring.test.ts`, which drives the
real composition with the stored zone and the host zone set to different values.

## Doc search (QMD-equivalent) — `@neutronai/doc-search`

The agent-native corpus search over the owner's project docs, so the live
agent can "research before asking" by searching every project's markdown
mid-conversation. It is the Neutron equivalent of the legacy harness's QMD.

- **Index (`doc-search/store.ts`).** A `bun:sqlite` FTS5 index over
  heading-scoped markdown chunks. `doc_chunks` holds the content; `doc_fts`
  is an external-content FTS5 mirror over `(title, heading, body)` kept in
  sync by triggers. Ranking is **BM25** with column weights (title ≫ heading
  ≫ body), normalised to a [0,1] relevance and collapsed to the best chunk
  per file, so a query returns ranked DOCUMENTS with the matching section's
  heading + a snippet. Pure-lexical keyword/BM25 — no external dependency and
  no embedding provider. (An optional in-process `embedder` seam once existed
  here for a hybrid semantic re-rank but was never wired — the composer always
  opened the index lexical-only — and could not share RA3's OUT-OF-process
  gbrain embedder; RA4 removed the dead seam.)
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
`gateway/wiring/build-gbrain-memory.ts#buildGBrainMemory`, which
returns the live trio the composer threads in — the `client`, the admin
"Memory" tab `memoryStore`, and the entity-writer `syncHook` (pages + graph
fan-out). `resolveGbrainClientOptions` is the pure config seam: it scopes the
`gbrain serve` child to `<owner_home>/gbrain` (`GBRAIN_HOME`) and forwards the
optional operator `GBRAIN_SOURCE` / `GBRAIN_BRAIN_ID`.

- **Agent memory RECALL (P0-2) — `memory_search` (`gbrain-memory/agent-tool.ts`).**
  The scribe WRITES entities + facts to this store on every turn; `memory_search`
  is the matching READ tool the spawned agent calls natively as
  `mcp__neutron__memory_search` (rides the P0-1 bridge). It is backed by the SAME
  `memoryStore.query` the admin Memory tab uses — one index, no second client —
  so the write→read asymmetry is closed: anything the scribe remembered is
  recallable mid-turn. `read:memory`, read-only, `{ query, limit? }` →
  `{ results: [{ id, title?, content, score, kind? }] }` (deduped by page; `title`
  + `kind` from the real GBrain row fields `title` / `type`); empty query lists
  recent pages; a host without the `gbrain` binary degrades to no results. A
  committed real-PGLite-brain round-trip test
  (`gbrain-memory/__tests__/agent-tool-real-brain.test.ts`) proves the full
  write→native-recall loop. This is the
  vault-wide / fast-fact recall surface — a different corpus than `doc_search`
  (project files) + `message_search` (chat history): GBrain holds the entity
  pages (people/companies/projects/meetings/concepts/originals) + scribe facts.
  Wired when `open/composer.ts` supplies `MiscCompositionInput.memory_search.store`
  (always, since `buildGBrainMemory` always builds the store).

- **Init guard — the brain is `gbrain init`'d before the first `serve` (ND1).**
  `gbrain serve` exits with "No brain configured" against an uninitialized
  brain, so before the dogfood fix prod served an un-init'd brain → every MCP op
  failed `Connection closed` → `memory_search` / scribe-write / admin Memory
  silently no-op'd (recall was masked by Claude Code file-memory). The fix:
  `gbrain-memory/ensure-brain-init.ts#ensureBrainInitialized` runs an idempotent
  `gbrain init --pglite --non-interactive` (skip-embed-check) the FIRST time the
  `GBrainStdioMcpClient` connects (`opts.ensureInitialized`, wired by
  `buildGBrainMemory`). Idempotent (no-op once `<GBRAIN_HOME>/.gbrain/config.json`
  exists) and fail-soft (a missing binary / failed init returns a status, never
  throws → the existing latched degrade-path). The brain is created
  **embeddings-ready at the ONE universal 768-dim column (RA3)** — the width the
  free local Ollama `nomic-embed-text` fallback emits natively AND that OpenAI's
  `text-embedding-3-large` slots into via Matryoshka truncation
  (`ensure-brain-init.ts#resolveInitEmbeddingTarget` pins EVERY fresh lineage —
  incl. the latent column an `off` install is pre-sized at — to 768). So a fresh
  brain does SEMANTIC recall out of the box via the local fallback with no key,
  and a later OpenAI key upgrades in place at the SAME 768 width — no schema
  rebuild. (A pre-RA3 brain persisted at 3072 keeps 3072; a key upgrades THAT in
  place at its existing width — the reconciler validates 1..3072 before handing
  the width to OpenAI.)
- **Default — HYBRID recall via a FREE local embedder (RA3).** Memory search runs
  vector (local Ollama `nomic-embed-text` @ 768d, over `OLLAMA_BASE_URL`, default
  `http://localhost:11434/v1`) + GBrain's BM25 keyword index + the typed-edge
  graph — out of the box, with no key and no env. If Ollama is unreachable / the
  model isn't pulled, GBrain's `hybridSearch` degrades each failed per-query embed
  to keyword-only, so recall fails SOFT to lexical (never crashes;
  `ensure-brain-init` probes once at boot and LOGS the degradation — not a silent
  no-op). The pre-RA3 keyword+graph-only mode is still available as the explicit
  `NEUTRON_EMBEDDINGS=off` opt-out. **`unset` is NOT off** — it selects the local
  fallback.
- **`off` is an AUTHORITATIVE kill switch — even over a persisted Ollama config.**
  Because RA3 makes Ollama the default, essentially EVERY brain persists
  `embedding_model: "ollama:nomic-embed-text"` in its `config.json`, and gbrain's
  `loadConfig` only lets `GBRAIN_EMBEDDING_MODEL` override that when it is TRUTHY —
  so an EMPTY serve env is NOT a kill switch (gbrain falls back to the persisted
  keyless Ollama and keeps embedding). `off` therefore emits a TRUTHY keyless
  DISABLE override (`GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large` with the
  key neutralized): with no usable credential gbrain's `noEmbed` is true, so it
  stores pages unembedded and never calls a provider, regardless of what's
  persisted. On the INIT side, `off` sizes the column at the shared keyless latent
  default (`openai:text-embedding-3-large @ 768`, no embeddings computed); removing
  `off` later (back to unset) simply re-activates the local Ollama embedder over
  that same 768 column and `embed --stale` backfills — no rebuild.
- **Fail-soft on the WRITE path too (RA3).** GBrain's `put_page` embeds inline and
  FAILS HARD when the configured provider is unreachable — and an Ollama provider
  needs no key, so a naive default would make EVERY memory write fail on a host
  without Ollama. So the serve seam (`resolveServeEmbeddingEnv` /
  `keylessDisableEmbeddingEnv` in `build-gbrain-memory.ts`) gates the local embedder
  on a reachability probe at each connect: reachable → embed with Ollama;
  unreachable / model-not-pulled (or a width-mismatch drop, or `off`) → emit the
  SAME keyless disable override as above (truthy `GBRAIN_EMBEDDING_MODEL`, key
  neutralized, and NO dims so gbrain keeps the persisted column width). With no key
  `isAvailable('embedding')` is false, so gbrain stores pages UNEMBEDDED (NULL-stale)
  and writes succeed. The next reconnect after Ollama returns forwards the real
  `ollama:*` env → `ensure-brain-init`'s unconditional `gbrain embed --stale`
  backfills those chunks IN PLACE. A cloud (OpenAI-key) embedder is never probed —
  it is assumed reachable.
- **Cloud (OpenAI) embeddings — the UPGRADE over the free local default
  (`gbrain-memory/embedder-config.ts`).** Two triggers select OpenAI
  `text-embedding-3-large` in place of the default local Ollama fallback
  (`resolveEffectiveEmbedder` in `build-gbrain-memory.ts`):
  1. **The onboarding-captured OpenAI key (the product path, ND1).** The
     onboarding optional-key offer (`onboarding/optional-keys.ts#OPENAI_OFFER`,
     "paste a key to unlock cloud embeddings") stores the key in the per-owner
     `ApiKeyStore` (`provider=openai`, label `onboarding`). The same key is
     manageable post-onboarding in the admin Integrations panel as the
     `openai_api_key` slot (a system slot in `gateway/cores/integrations.ts`,
     persisting under the SAME secrets label so onboarding ↔ admin share one key).
     Because that capture is explicit + purpose-stated, using it for (billable)
     embeddings is consensual, not a surprise.

     **The composer reads the key LAZILY, at the first `gbrain serve` spawn — NOT
     at boot.** The boot path composes the GBrain wiring ONCE, at process boot,
     but the key is captured LATER, over the already-running server (during
     onboarding, or via the admin panel). An eager read at composition would
     therefore miss every freshly-pasted key until a restart — the bug behind
     "the OpenAI embeddings key is supposed to be wired to GBrain but isn't."
     Instead the composer threads a resolver thunk
     (`resolveOnboardingOpenAiKey` → `buildGBrainMemory({ resolveOpenAiKey })`),
     and `buildGBrainMemory` calls it when a `gbrain serve` connection is created:
     the lazily-resolved embedder env (`GBRAIN_EMBEDDING_*` + `OPENAI_API_KEY`) is
     merged into the `gbrain serve` child via
     `GBrainStdioMcpClientOptions.resolveDynamicEnv`, and `ensureBrainInitialized`
     inits against that same embedder and backfills pre-key pages via
     `gbrain embed --stale`. **Activation cadence — per-spawn, NOT
     mid-connection.** The `GBrainStdioMcpClient` connects LAZILY on the first
     memory op and then holds ONE long-lived connection for the process: every
     later op returns the existing client, and the dynamic embedder env is
     resolved ONLY at connection CREATION (`gbrain-stdio-client.ts` — the init
     guard re-arms on `close()` / after a failed connect, not on a live client).
     So a key stored while a connection already exists is picked up the next time
     that connection is **(re)created** — a reconnect (a transient drop, or the
     process teardown/restart that `open/wiring/memory.ts` closes it on) — **NOT
     necessarily on the immediate next turn** of an already-open connection. It
     activates "next turn" only in the case where no connection exists yet when
     the key lands (the lazy first spawn reads it). The key is memoized per connect
     so the init guard + serve child agree on the embedder selected then;
     `null`/absent → keyword + graph, byte-for-byte unchanged. (A
     mid-live-connection hot-swap — activate WITHOUT a reconnect — is out of RA3
     scope; a possible RA2 follow-up.)
  2. **The operator env override (`NEUTRON_EMBEDDINGS`).**
     `resolveEmbedderConfig(env)`: **`unset` (DEFAULT) → local Ollama
     `nomic-embed-text` @ 768d** (embeddings ON); `off`/`0`/`false`/`none` →
     keyword + graph only (the explicit opt-out); `openai` →
     `text-embedding-3-large` at the shared **768d** width (needs a key,
     `NEUTRON_EMBEDDINGS_OPENAI_API_KEY` ← `OPENAI_API_KEY`); `ollama` →
     `nomic-embed-text` @ 768d (explicit, e.g. a custom `OLLAMA_BASE_URL`);
     `auto`/`on`/`1`/`true` → OpenAI when a key is present, else the local Ollama
     fallback. A bare `OPENAI_API_KEY` (consumed by the GPT LLM adapter) does
     **not** enable embeddings on its own — only `auto`/`openai` (or the separate
     onboarding-key path above) does.

  A non-null embedder is the child env (`GBRAIN_EMBEDDING_MODEL` =
  `provider:model`, `GBRAIN_EMBEDDING_DIMENSIONS`, provider auth/base-url) that
  `resolveGbrainClientOptions` merges into the `gbrain serve` child so GBrain
  embeds-on-write and hybridSearch goes semantic. **NOTE:** OpenAI sign-in /
  OAuth (`codex login`, the separate `codex_auth` offer for cross-model GPT-5
  reviews) does NOT authorize the embeddings API — gbrain's embedder requires a
  platform key (`gbrain/src/core/ai/gateway.ts`: "OpenAI embedding requires
  OPENAI_API_KEY"), which is why the embeddings offer is a guided key paste.

- **Installer provisions the binary (`install.sh#ensure_gbrain`).** The runtime
  above spawns `gbrain serve`; without the `gbrain` binary on PATH that spawn
  fails and memory degrades SILENTLY to on-disk entity pages (latched after the
  first `Executable not found in $PATH: gbrain` — see
  `gbrain-memory/memory-store.ts#isGbrainBinaryMissingError`). So a fresh
  self-host gets REAL memory out of the box, `install.sh` installs GBrain by
  default in the Dependencies phase via `bun install -g github:garrytan/gbrain`
  (source ref overridable with `NEUTRON_GBRAIN_REF`). The step is **idempotent**
  (an already-present `gbrain` is detected, not reinstalled) and treats GBrain as
  a **REQUIRED dependency, not best-effort**: a successful `neutron` install
  GUARANTEES `gbrain` on PATH. Transient failures (network / github rate-limit /
  native-build blips) are **retried** up to 3 attempts with a short backoff
  (`NEUTRON_GBRAIN_ATTEMPTS` / `NEUTRON_GBRAIN_RETRY_DELAY`); if after retries the
  binary is STILL unresolvable on PATH the installer **ABORTS** (`die`) with an
  actionable error — the manual `bun install -g …` recovery command plus the
  `--no-gbrain` escape hatch — rather than silently shipping degraded memory. The
  ONLY way to install without it is the explicit `--no-gbrain` /
  `NEUTRON_SKIP_GBRAIN=1` opt-out, which stays graceful (warns and continues;
  memory degrades to disk-only). Covered by
  `tests/integration/install-gbrain.test.ts` (9 cases — abort-on-failure,
  retry-then-abort, retry-then-succeed, PATH-gap abort, graceful opt-out, success
  path) via the `NEUTRON_INSTALL_PRINT_GBRAIN` seam.

- **Service-PATH reachability — the binary the install GUARANTEES must be
  reachable by the running SERVICE (dogfood 2026-06-28).** `install.sh` lands
  `gbrain` at `~/.bun/bin/gbrain`, but that dir is on the install script's own
  shell PATH — NOT the curated PATH launchd/systemd give the long-running
  server. So `Bun.which('gbrain')` returned `null` inside the service even
  though the binary existed → the init guard above could never spawn `gbrain
  init` (the brain's `.gbrain/config.json` stayed ABSENT) → memory silently
  DISABLED on every install, masked by Claude-Code file-memory. ND1 fixed the
  init *logic* but not *reachability*. The fix is two complementary parts:
  1. **Runtime absolute-path resolver (`gbrain-memory/resolve-gbrain-command.ts`)
     — repairs EXISTING installs on a code-update + restart, no plist regen.**
     `resolveGbrainCommand(env)` returns an ABSOLUTE gbrain path: `Bun.which`
     first (honor a working PATH), else probe `$BUN_INSTALL/bin`, `~/.bun/bin`,
     `/usr/local/bin`, `/opt/homebrew/bin`, `~/.local/bin` — first executable
     wins, else `null` (preserving the fail-soft disabled path; never throws).
     `buildGBrainMemory` passes that absolute path as the stdio client's
     `command` (and to `ensureBrainInitialized`), and uses the SAME resolver for
     the boot-time "DISABLED" warning decision (not a bare `Bun.which`). Because
     `gbrain` is a `#!/usr/bin/env bun` script, the resolver also builds the
     child's PATH (`resolveGbrainChildPath`) so it carries the gbrain dir AND a
     `bun` dir (`process.execPath`) — the shebang re-resolves even under the
     narrow service PATH. The doctor (`realProbes`) uses the same resolver for
     detection + spawns, so one resolver backs both serve-spawn and doctor; its
     `memoryRoundtrip` probe also wires the production `ensureInitialized` guard
     so it `init`s its ephemeral brain before `serve` (previously it hit "No
     brain configured" → `Connection closed` once the binary became reachable,
     falsely reporting DEGRADED on healthy installs).
  2. **Service-PATH correctness (`neutron-service.sh#_service_path`) — fresh
     installs' plist/unit.** The generated launchd plist / systemd unit PATH now
     includes `${BUN_INSTALL:-$HOME/.bun}/bin` (the bun global-bin dir, distinct
     from the bun *binary* dir), so a freshly generated unit already resolves
     gbrain. Pure addition to the existing curated list, dedup-safe.
  Covered by `gbrain-memory/__tests__/resolve-gbrain-command.test.ts`,
  `tests/integration/service-gbrain-path.test.ts`, and the disabled-warning
  cases in `gateway/wiring/__tests__/build-gbrain-memory.test.ts`.

- **Auto-upgrade + doctor (`gbrain-memory/gbrain-doctor.ts`).** `ensure_gbrain`
  pins a point-in-time snapshot of an UNPINNED default branch with no upgrade
  path and no health verification. The doctor — modeled on the legacy harness's
  `cc-update-doctor` — closes both gaps with a deterministic, NO-LLM engine:
  - **DOCTOR** (`neutron doctor`) verifies gbrain actually WORKS, not just that
    the binary exists: (1) `gbrain` on PATH, (2) the binary responds
    (`gbrain --version`), and (3) a real **memory round-trip** — connect →
    `put_page` → `list_pages` read-back through the PRODUCTION transport
    (`GBrainStdioMcpClient` → `GBrainMemoryStore`) against an EPHEMERAL throwaway
    brain (a temp `GBRAIN_HOME`), so it exercises the live code path without
    touching the owner's brain. Downstream checks short-circuit (a missing
    binary can't round-trip) and are reported `skipped`.
  - **AUTO-UPGRADE** (`neutron doctor --upgrade`) resolves the latest upstream
    commit (`git ls-remote github:garrytan/gbrain HEAD`), and re-installs ONLY
    when it advanced past the recorded ref — IDEMPOTENT, pinned to the resolved
    commit (`github:garrytan/gbrain#<sha>`) for reproducibility since gbrain
    ships no semver release tags. It then runs the doctor to VERIFY; an upgrade
    that breaks the round-trip ROLLS BACK to the previously-recorded ref (the
    `cc-update-doctor` contract). The recorded ref + last-verified state live at
    `<NEUTRON_HOME>/gbrain-doctor.json`.
  - **Host-level, never in-process.** Neutron runs GBrain in **notify** mode
    inside a running instance and NEVER silently auto-upgrades there — a memory
    schema change mid-session is volatile state the owner must gate (see
    `gbrain-memory/version-notice.ts`). So the auto-upgrade runs OUT of the
    instance process: `install.sh` schedules `neutron doctor --upgrade` on a
    daily cadence via `neutron-service.sh install-doctor` (launchd
    `StartInterval` / systemd `.timer`, the same boundary `cc-update-doctor`
    runs at), opt-out aware (`--no-gbrain`) and best-effort (a scheduling
    failure never aborts the install). Covered by
    `gbrain-memory/__tests__/gbrain-doctor.test.ts` (working-vs-broken
    detection + idempotent upgrade + rollback, against injected probes).

- **Consolidation correctness — dedup / supersede / resynth invariants
  (`scribe/reflect/`, `scribe/write-to-gbrain.ts`).** The reflect batch pass
  (`scribe/reflect/reflect-pass.ts`, armed by default — the reflect batch runs
  every 6h, `DEFAULT_REFLECT_INTERVAL_MS = 6 * 60 * 60 * 1000`; the
  `NEUTRON_PERFECT_RECALL` gate was collapsed 2026-07-20, M2-3/P0-4) mutates the
  owner's canonical corpus, so its correctness is load-bearing. Three
  data-integrity guards (memory-system-design-2026-07-20 blockers 1–3) constrain
  what it may do:
  - **Near-duplicate DEDUP never fuses unrelated entities** (`scribe/reflect/jaccard.ts`).
    Similarity scoring (a) strips ONLY *generated* boilerplate before scoring —
    the generated title H1 (`# <Name>` where the label equals the page title),
    the generated section headings (`## Relationships`, `## Merged`), and the
    fact-less `Mentioned in chat (kind: X).` line — and NEVER a hand-authored
    factual heading (`stripBoilerplate`); (b) KEEPS numeric/alphanumeric tokens
    (`2024`, `q1`, `v2`) that `Intl.Segmenter` marks non-word-like, so fiscal-year
    / versioned / quarterly pages keep their only discriminator (`tokenize`,
    ISSUES #373); (c) clusters as CLIQUES (every pair ≥ threshold, no transitive
    closure) and requires a page to carry ≥ `MIN_DISTINGUISHING_TOKENS` (= 2)
    non-boilerplate tokens to be a merge candidate at all — so fact-less
    boilerplate pages (which strip to ~0 tokens) never merge. The Jaccard
    threshold (`DEFAULT_JACCARD_THRESHOLD` = 0.7) is `deps.jaccardThreshold`-
    configurable and flagged UNVALIDATED as a TUNING knob (re-measure the
    false-merge rate on a real corpus and tune down). Consolidation is armed by
    default (6h, P0-4), so the two false-fusion signatures the raw 0.7 cut alone
    would let through are NOT left to threshold-tuning — they are blocked OUTRIGHT
    by the **`isMergeSafeCluster` merge-safety gate** (`scribe/reflect/jaccard.ts`),
    which `dedupPages` applies to every candidate cluster BEFORE the irreversible
    fuse (a held cluster increments `report.held` and is logged loudly):
    - Gate A (**shared name token**) HOLDS two DIFFERENT-named entities that reach
      the bar only via shared relation targets — e.g. `Bob` / `Carol` each
      `Works at [[org0]]/[[org1]]/[[org2]]` score 5/7 = 0.714 ≥ 0.7 but share no
      name token, so they are never fused.
    - Gate B (**corroboration beyond the name** — excluding the name, members must
      still be pairwise ≥ threshold similar on BODY-ONLY tokens) HOLDS two DISTINCT
      fact-less entities sharing an identical ≥ 2-word name (two "John Smith" pages
      score 1.0 on name tokens alone but collapse to empty body sets once the name
      is excluded), so they are never fused.

    A held cluster is a deliberate MISSED merge (the always-safe direction — never
    an irreversible false fusion); the loud log lets the owner hand-merge a genuine
    duplicate the gate was conservative on.
  - **The merge is REVERSIBLE — merged-away losers are archived, never hard-deleted**
    (`scribe/reflect/merge-archive.ts`). The gate above prevents the *identity*
    fusion, but Jaccard is still a heuristic and any merge it does allow may be
    wrong — so no loser is unlinked until its EXACT bytes are copied to
    `<ownerDataDir>/memory-archive/<kind-dir>/<slug>.<stamp>.md` and the merge is
    recorded in `<ownerDataDir>/memory-archive/merges.jsonl` (when, which page,
    which survivor absorbed it). **A failed archive BLOCKS the delete**: the loser
    is retained, not counted as merged, and a later pass retries — "couldn't write
    the backup" never degrades into "deleted it anyway". `report.archived` makes
    that observable, and every merge now emits an owner-readable log line naming
    the archive path + the restore command (previously a successful merge was
    logged nowhere at all). Details in § Memory archive below.
  - **Supersede is keyed on the graph TRIPLE, not sentence shape**
    (`stripSupersededSentences`, `scribe/write-to-gbrain.ts`). A superseded
    relation's sentence is retired whenever it asserts exactly one graph relation
    that is a superseded target — REGARDLESS of prose form — so a supersede still
    works after a resynth rewrites compiled-truth into natural prose (previously a
    permanent no-op). Compound sentences (more than one relation) are still spared
    entirely. Accepted residual: a single-relation sentence carrying descriptive
    prose is dropped IN FULL — the retired relation persists as an additive dated
    timeline row (`works_at oldco`), but `stripSupersededSentences` is a pure
    compiled-truth transform that writes NOTHING to the timeline, so the sentence's
    descriptive detail and any co-located still-current non-edge fact (e.g.
    `earns $400k`) leave current truth and are not re-recorded. Runs under the
    always-on consolidation default (the `NEUTRON_PERFECT_RECALL` gate was
    collapsed 2026-07-20, M2-3/P0-4).
  - **Resynth may not drop OR mutate a predicate** (`preservesEdges`,
    `scribe/reflect/reflect-pass.ts`). The accept-gate compares extracted
    (predicate, object) PAIRS, not just wikilink targets, so a rewrite that keeps a
    target but changes its verb (`Works at [[acme]].` → `Mentions [[acme]].`) is
    REJECTED — the edge can never silently degrade, and a predicate-scoped supersede
    can always still retire it.
  - **Correction-pattern promotion — reflect-pass STEP 4** (`scribe/reflect/
    reflect-pass.ts`, `scribe/reflect/correction-patterns.ts`). The 6h reflect
    loop, after dedup/supersede/resynth, ALSO clusters recurring owner corrections
    (`clusterCorrections`) and promotes each ≥3-occurrence cluster to a
    kind-`concept` entity page with a WINDOW-INVARIANT slug `correction-pattern-<digest
    of the cluster's majority `right`-field vocabulary>` (`stablePatternSlug` /
    `composePatternPage`, `scribe/reflect/correction-patterns.ts`) — invariant so
    the page is UPDATED, not duplicated, as occurrences age out of the 200-scan
    window. It is
    deterministic and substrate-independent (runs on LLM-less boxes) and gated only
    on an injected `readCorrections` seam — absent ⇒ step 4 skipped, no
    scribe→reflection package edge. The report gains `correctionsScanned` /
    `patternsPromoted`.

- **Q2 — dreaming's uncovered half lives IN core memory, split by tier
  (overturn 2).** The pieces of the legacy harness "dreaming" that scribe/reflect did not
  already cover were folded into the core memory subsystem BY TIER — deliberately
  NOT as one monolithic "dreaming ritual", and NOT all inside the 6h loop:
  - **Entity backlink repair is EVENT-DRIVEN on the entity-writer sync hook**, not
    part of the 6h reflect loop. `wrapSyncHookWithBacklinkRepair`
    (`runtime/backlink-repair.ts`) wraps the sync hook OUTERMOST at
    `open/wiring/memory.ts:231` (`gbrainSyncHook = backlinkRepairHook`), so every
    entity write inspects new links, and a UNIQUE strip-hyphen-key match rewrites
    the source page's wikilinks via a CAS `writeEntity` + a `backlink-repair:<slug>`
    provenance row; orphan/ambiguous targets are logged and left untouched. A
    coalesced single-flight drain enumerates the existing-slug corpus once per
    cycle.
  - **Correction-pattern promotion runs INSIDE the 6h loop** (reflect-pass step 4,
    above).
  - **Daily-delta notes are GONE** (2026-08-01). They were the time-anchored
    survivor of the split and shipped as a third bundled ritual, but the owner
    dropped them: the delta existed mostly to show the memory layer was alive, and
    proving the system still works is now the reachability gates' job, not a daily
    message. The bundled slot it occupied is `kaizen` — which reads the same
    corrections log and diary, weekly, and produces an ACTION rather than a status
    line. See the Ritual executor section.

## Memory archive — undoing a wrong auto-merge (`scribe/reflect/merge-archive.ts`)

The reflect pass's dedup step is the only thing in Neutron that DELETES an
owner memory page, and it decides what to delete from a similarity heuristic.
The archive makes that decision reversible.

- **Layout.** `<ownerDataDir>/memory-archive/` — a sibling of `entities/`,
  `diary/` and `corrections/`, deliberately OUTSIDE the tree the reflect pass and
  `runtime/memory-index.ts` enumerate. An archived page is INERT: never scanned,
  never re-merged, never surfaced as live memory until it is restored.
  - `<kind-dir>/<slug>.<stamp>.md` — the loser's raw body, BYTE-EXACT. No injected
    frontmatter, no header, no reformatting; restoring reproduces the deleted page
    exactly. All merge context lives in the ledger, never in the copy.
  - `merges.jsonl` — append-only, one JSON row per merge: `archived_at`, `kind`,
    `slug`, `merged_into`, `merged_into_kind`, `file`, `bytes`. Malformed lines
    are skipped, so a torn tail never makes the archive unreadable.
  - `README.md` — written on first use: plain-English restore instructions for
    someone who just opens the folder.
- **Archive BEFORE delete, and a failed archive BLOCKS the delete.** In
  `mergeCluster` the copy is written first; if it throws, the loser is RETAINED
  (both pages stay on disk, `report.merged` does not count it, a later pass
  retries). There is no path that removes a page without a recoverable copy.
- **Content-idempotent.** Re-archiving bytes already stored for a (kind, slug)
  reuses the existing file and writes no new ledger row — so a loser whose delete
  keeps conflicting (re-archived every 6h) cannot accrete copies.
- **Recovery — `neutron memory-restore`** (`scribe/reflect/memory-restore-cli.ts`,
  dispatched from `bin/neutron`). No argument lists every page merged away and
  what absorbed it; `neutron memory-restore <slug>` writes it back to
  `entities/<kind>/<slug>.md` byte-for-byte. It REFUSES to clobber a live page
  unless `--force` — recovering a bad merge must never be able to destroy a good
  page. After a restore the survivor still carries the folded copy under a
  `## Merged` heading; that section has to be deleted from the survivor or the
  next pass re-merges the pair (the CLI says so).
- **Retention — 90 days** (`MERGE_ARCHIVE_RETENTION_MS`). `pruneMergeArchive`
  runs once per reflect pass: copies past the horizon are unlinked and their
  ledger rows compacted away. The archive is a fixed-horizon undo, not a second
  permanent copy of the corpus — unbounded retention would silently double a
  growing memory corpus on disk and in every backup.
- **Discoverability.** A successful merge previously logged NOTHING (the pass's
  report is a return value nobody reads — `open/wiring/memory.ts` discards it).
  It now emits one `scribe` log line per merged-away page naming the removed
  page, the survivor, the archive path and `neutron memory-restore <slug>`, so
  the moment the owner notices a page missing, the log (`neutron logs`) tells him
  how to get it back.

## Credential management — onboarding OPTIONAL keys (WAVE 1) — `onboarding/optional-keys.ts`

The admin add/rotate path (`app/app/admin.tsx` → the gateway admin surface)
and the per-instance key store (`auth/api-key-store.ts:ApiKeyStore`) already
exist. WAVE 1 adds the missing front-door: onboarding offers the common
OPTIONAL keys UP FRONT as optional questions. The system runs fully on
Claude Max OAuth (or a BYO Anthropic key) alone — **every** offer is
skippable and skipping leaves the system fully working; a provided key only
ADDITIVELY activates a capability.

- **Single source of truth (`onboarding/optional-keys.ts`).**
  `OPTIONAL_KEY_OFFERS` declares each offer (id, the question, the capability
  it unlocks, the activation requirement, and the skip note).
  `storeOptionalKey(apiKeys, …)` validates + persists a provided key through
  the **existing** `ApiKeyStore` — the same store the admin UI and the runtime
  credential resolver read, so there is one key path, not two. To keep
  `@neutronai/onboarding` decoupled from `@neutronai/auth`, the module depends
  on a narrow `OptionalKeyApiKeyStore` interface (the real `ApiKeyStore`
  satisfies it structurally; this mirrors the engine's `MaxOauthSecretsStore`
  pattern).
- **`openai_api_key`** → stored via `ApiKeyStore(provider='openai')`. It
  becomes resolvable by `gateway/wiring/resolve-llm-credentials.ts`
  (→ `auth/byo-api-key-fallback.ts:buildBYOApiKeyPool`), which **activates**
  the OpenAI / GPT-5 API adapter used for cross-model trident reviews. The
  SAME key backs cloud embeddings (`gbrain-memory/embedder-config.ts`), which
  additionally require the explicit `NEUTRON_EMBEDDINGS=openai|auto` opt-in —
  the deliberate cost guard above, so a stored key never silently bills
  embeddings.
- **`codex_auth`** → the Codex CLI subscription OAuth (`codex login`), a
  HOST-level credential under `CODEX_HOME`, not a per-instance paste secret
  (the `ApiKeyProvider` enum has no `codex`). The offer surfaces it as
  guidance; operators who prefer a platform key use the `openai_api_key`
  offer, which the GPT-5 API adapter consumes for the same cross-model reviews.
- **Phase wiring.** The offers surface during the existing credential step
  (`max_oauth_offered`): its knowledge pack (`phase-spec-resolver.ts`) carries
  `optional_openai_key` / `optional_codex_auth` FAQs + tangents derived from
  the canonical offer registry, so the onboarding agent answers in lockstep
  with what actually gets stored. The phase enum + `LEGAL_TRANSITIONS` are
  unchanged — the optional keys are additive to the substrate choice, never a
  new gate, so skipping them is the zero-friction default.
- **Activation sink differs by deployment tier.** `storeOptionalKey` →
  `ApiKeyStore` is the **managed** activation path (the per-instance resolver
  `resolveLlmCredentials` reads `ApiKeyStore`), and is what the integration
  test exercises end-to-end. **Open self-host** resolves LLM credentials from
  **env** instead (`open/composer.ts:resolveOpenLlmPool` →
  `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`; embeddings + the GPT adapter
  read `OPENAI_API_KEY` / `NEUTRON_EMBEDDINGS_*` from the owner env file), so
  the open-mode activating sink is the owner's `.env` (read on next boot), not
  `ApiKeyStore`. This slice ships the offer registry + the storage primitive +
  the conversational surfacing; the **interactive collector** (a paste
  affordance on the credential step) and the per-tier intake closure (managed:
  an `ApiKeyStore`-backed hook; open: an env-file writer) are the explicit
  next slice — the primitive is deliberately landed and proven first.
- **Open also accepts an ambient/Keychain-authed `claude` (single-owner).**
  Beyond explicit env tokens, `resolveOpenLlmPool` accepts a `claude` that is
  already authenticated via ambient/Keychain auth (the macOS "Claude
  Code-credentials" item, or `~/.claude/.credentials.json` elsewhere) — detected
  by a cheap, cached, never-hanging probe (`open/ambient-claude-auth.ts`). This
  is what un-bricks a fresh Mac install whose owner already ran `claude` login:
  before it, `GET /chat` 503'd ("Authenticate Claude") and the box booted
  LLM-less even though `claude -p` worked headlessly. A hit yields a new
  `ambient`-kind credential whose substrate threads NO token, so the spawned
  `claude` child auths via its own Keychain. Explicit tokens win and the probe
  never runs when one is set.
- **Auth resolution order + the handoff DEFAULT (AUTH-CORRECTION 2026-06-28).**
  `resolveOpenLlmPool` order: **env OAuth/API token → Keychain fast-path (#101) →
  `null`**. The `null` case no longer renders a dead 503 — it renders the
  FUNCTIONAL Claude-Max OAuth **handoff** (the DEFAULT the UX assumes: no token,
  no Keychain — Linux/headless boxes, fresh installs). `GET /chat`'s gate page
  (`landing/server.ts:renderChatAuthGateHtml`, pinned by a `sha256-` CSP) drives
  `open/install-token-handoff.ts`'s routes (`/oauth/max/install-token/{initiate,
  <id>.sh,complete,state}`, mounted via `installTokenHandler`): a copy-paste
  one-liner installs `claude`, runs `setup-token`, captures the `sk-ant-oat…`
  token, and POSTs it back. `/complete` persists the token to `.env`
  (`open/install-token-env.ts`) and exits so the launchd/systemd supervisor
  respawns with a LIVE substrate (the composer resolves creds once at boot); the
  page polls `GET /chat` for the 503 → restart → 200 transition and auto-advances
  into onboarding. The Keychain fast-path stays a save-a-step optimisation;
  `NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH=1` forces the handoff even when a host
  `claude` login exists (headless deployments with no Keychain; deterministic
  tests). Open persists to `.env`; a hosted/multi-instance deployment's own
  handoff (tracked in that deployment's repo) persists into an encrypted
  per-instance secrets store with an HMAC-gated `/complete`.
- **The tenant-side auth screen is MANAGED-UNREACHABLE (#371 backstop).** The
  install-token / Claude-auth surface above is an OSS **self-hoster** affordance
  — a self-host box has no control plane and must auth on its own machine. On a
  **managed** tenant the control plane owns auth (the tenant is seeded with the
  Max token by the control-plane handoff), so the tenant-side screen must NEVER
  render — it once LEAKED a DUPLICATE auth prompt into the managed flow (#371).
  `createLandingServer` resolves the deployment role (`LandingServerOptions.
  deploymentMode`, threaded from `resolveDeploymentMode()` in
  `gateway/wiring/build-landing-stack.ts`; env-derived `NEUTRON_ROLE` backstop
  via `resolveLandingDeploymentMode` when the option is unwired). When the role
  is `managed`, `landing/server.ts` gates the surface OFF: the four
  `/oauth/max/install-token/*` routes and the `GET /chat` auth gate both serve a
  neutral `renderManagedProvisioningHtml` "your workspace is being provisioned"
  page (HTTP 503) instead of the OSS one-liner auth screen. Open/self-host (the
  default) is unaffected — its only auth path serves normally. This is
  belt-and-suspenders: it holds even if a composer wrongly wires
  `installTokenHandler` on a managed box.
- **On-demand Reconnect affordance (2026-07-24) — the auth-reconnect bubble's
  one-click button.** When a live chat turn's `claude` child fails on an
  invalid/expired token, the turn runner surfaces the `AUTH_RECONNECT_BODY`
  bubble (`gateway/wiring/build-live-agent-turn.ts`, `sendAuthReconnect`). On the
  live-agent path that bubble now carries a single **"Reconnect"** button
  (`value = RECONNECT_AUTH_VALUE`). A tap routes the sentinel back as the next
  turn, where the runner intercepts it BEFORE user-turn persistence and mints a
  FRESH install-token command on demand — the SAME `installTokenHandler` the
  first-time gate drives, via the composer's `reconnectHandoff` seam
  (`open/install-token-handoff.ts` `buildReconnectHandoff`) — then replies
  in-chat with the copy-paste terminal command. Unlike the freeze-timeout Retry
  button it does NOT re-run the last message (that would just re-hit the invalid
  token), and the LLM substrate is never dispatched for the tap. The button is
  offered ONLY when the seam is wired (so no dead button); an LLM-less box or a
  failed mint degrades to the static manual instructions.
  **Known limits (tracked, non-blocking at dogfood stage):** the reconnect
  command is minted at a LOOPBACK origin (`http://127.0.0.1:<port>`), not the
  request-derived public origin the first-time gate uses (which honours
  `X-Forwarded-*`). It is therefore runnable only by someone with a SHELL on the
  machine running Neutron. A shell-less remote owner, or a managed-tenant owner
  who has no SSH to the tenant box, cannot run a loopback command — a
  request-origin-derived reconnect for those deployments is future work. The
  seam's port comes from `NEUTRON_PORT` (else `DEFAULT_LISTEN_PORT`); a `--port=`
  argv / free-port dev run is the one unshipped case where the minted port can
  diverge from the bound port.

## Usage meter — the active credential's two ceilings, drawn as the tab-bar divider

A Claude subscription is metered against a rolling **5-hour session** window and a
rolling **7-day** window. Neutron surfaces both as the line that separates the tab
bar from the chat: two 1px rules, session on top, weekly below, each filling from
the left, the whole fill green under 85%, amber to 95%, red past it. It is the
divider, not a widget beside one — so it costs no layout and no attention until
the colour changes.

**Exactly ONE credential is described HERE.** The meter's reading is always the
credential the box is dispatching with right now. There is no pooling, no
averaging, and no multi-account concept in this path — a deployment that swaps
credentials underneath simply gets the new one measured on the next tick. The
readings the probe produces are also persisted, and the surface that reads that
history is multi-pool and multi-account: see **Usage dashboard** below. The two
are deliberately different scopes of the same measurement, not two sources of it.

- **Where the numbers come from — `auth/credential-usage-probe.ts`.** Anthropic
  reports utilization on the response headers of an authenticated API call
  (`anthropic-ratelimit-unified-5h-utilization` / `…-7d-utilization`, plus the
  matching `…-reset` epoch-seconds headers, normalised to ms at the boundary).
  Turns are dispatched by spawning the `claude` binary, which surfaces no response
  headers to us, so the figures cannot be observed by watching normal traffic —
  they are asked for, with a one-token `POST /v1/messages` whose body is never
  read. This is an auth-tier probe in the same class as `auth/max-oauth.ts`'s
  token check, not an LLM call site; it carries no owner content, no `system`
  field and no signature. `parseUnifiedRateLimitHeaders` is exported as a pure
  function so any other consumer of these headers shares one definition of which
  header means what — and it takes `now` as a PARAMETER rather than reading a clock,
  so every consumer also shares the plausibility bound below rather than being able to
  opt out of it by accident. Each `…-reset` instant is bounded after conversion, the
  same rule Kimi's equivalents get: refused more than 30 days out (a header already in
  milliseconds, multiplied again, rendered as a countdown of "11574074d 1h" with
  nothing flagging it) or more than five minutes of clock skew in the past. A refused
  instant is absent, and an absent instant renders "unknown" — never "now". The API
  base is threaded from the composition env (`ANTHROPIC_BASE_URL`, the variable the
  Anthropic SDK itself reads), so a box pointed at a gateway keeps its gauge pointed
  where its turns go.
- **Which credential — `open/active-credential.ts`.** Walks the same precedence
  `resolveOpenLlmPool` uses, resolving one tier further than dispatch needs:
  `CLAUDE_CODE_OAUTH_TOKEN`, then `ANTHROPIC_API_KEY` (per-token billing — no
  windows, so no meter), then the token in
  `<CLAUDE_CONFIG_DIR|~>/.claude/.credentials.json`, which is where the `claude`
  CLI keeps a subscription login and therefore where a hosted deployment installs
  and rotates the credential it has chosen. Reading that file is what makes the meter
  correct on a hosted instance with no hosting-side code. A macOS Keychain-only
  login cannot be read from a background loop and reports unsupported.
- **When — `open/credential-usage-monitor.ts`.** A `SupervisedLoop` measures every
  60 s (immediate at boot) and caches the reading; the HTTP handler always answers
  from memory. A reading older than `USAGE_MAX_AGE_MS` (5 min) stops being quoted
  — a utilization figure describes a rolling window, so a stale one is wrong, not
  merely old. A transient probe failure keeps the last good reading until that
  ceiling; an unauthorized or window-less credential drops it immediately. An
  unmeasurable credential generates NO upstream traffic at all.
- **Serving — `gateway/http/app-usage-surface.ts`, `GET /api/app/usage`.**
  Owner-gated. Always 200 on an authenticated request: either a reading with its
  `measured_at`, or `{available:false, reason}` where the reason is
  `no_credential` / `not_measured_yet` / `unsupported_credential` / `probe_failed`.
  "Unknown" is a legitimate answer, not an error — making each client infer a
  display state from a status code is how two clients drift apart.
- **Contract — `contracts/credential-usage.ts`.** The payload shape, the 0.85 /
  0.95 thresholds and `usageBand()` live here and are imported by the gateway, the
  web bundle and the RN app, so the three cannot disagree about where amber starts.
- **Web — `landing/chat-react/UsageMeter.tsx` + `usage-client.ts`.** Rendered by
  `ProjectShell` between `.car-topbar` and `.car-stage`; the topbar no longer draws
  its own `border-bottom` and the active tab no longer overhangs it by -1px (a
  notch in a fill bar reads as a wrong number, not as a fused tab). Polled every
  60 s. Colours are the `--usage-nominal` / `--usage-warning` / `--usage-critical`
  tokens, defined for both themes.
- **Mobile — `app/components/UsageMeter.tsx` + `app/lib/usage-client.ts`.** The RN
  twin, rendered as the last child of `ProjectTabBar`'s `narrowBand` (which
  likewise dropped its `borderBottomWidth`). `useCredentialUsage` polls on the same
  interval and refetches on foreground; it stays idle without a runtime-configured
  server and a token, so an unconnected device issues nothing.
- **Degradation is the point.** No credential, no measurement yet, an API key, or
  an unreachable/unmounted route all render as the plain divider that was there
  before the meter existed. The clients never coerce a missing number to zero: an
  empty coloured track would assert "0% used", which is a claim, and the whole
  purpose of the unavailable state is that there is none to make.

## Usage dashboard — every connected account, and when capacity comes back

The meter says how full ONE window on ONE credential is. The dashboard answers the
two questions a single reading cannot, for every provider this instance can see:
**"is this going to run out before it resets"** (pace, and the cap-out projected
off it) and **"when does capacity COME BACK"** (a countdown to each window's
reset). They are opposite questions and both ship — pace says when the wall
arrives, the countdown says when it moves, and the second one is the input to the
throughput decision of whether to raise build concurrency.

- **The series — `migrations/0121_usage_pool_samples_account_grain.sql`,
  `persistence/usage-samples-store.ts`.** One row per (instant, pool, account),
  30-day retention, pruned by the writers' own ticks. The key carries the account
  because the dashboard answers a per-account question: two accounts of one pool
  measured in the same millisecond must be two rows, not one overwrite that serves
  the second account's numbers under the first one's name. `account_label` is
  `NOT NULL` with an empty-string sentinel for "nothing can name this account" —
  a nullable column in a primary key is not a key, since SQLite compares NULL to
  NULL as unequal — and the store maps that sentinel back to `null` at the
  boundary, so no surface can mistake it for a name. `session_window_ms` /
  `weekly_window_ms` carry the window LENGTH the provider reported: pace divides
  by it, lengths are not a constant across providers, and Codex has already
  changed regime once, so a series that straddles the change is summarised
  per-sample rather than with one global constant. A utilisation outside `[0, 1]` is
  not a reading and is refused HERE, on the write side and again on the read side,
  because this is the boundary every writer crosses: `Number.isFinite` alone lets a
  negative through, and a negative fraction divided by elapsed renders as a NEGATIVE
  pace — "−0.2×", which the card paints as comfortably within the refill rate. The
  Kimi parser refuses negatives at its own edge; the Anthropic header path does not
  (`numberHeader` returns any finite parse), so one writer's guard was never the
  property. Above 1 is refused rather than clamped, because a percent under a
  fraction's name clamped to 1.0 is an unreadable field rendered as a confident
  "fully spent".
- **Pools — `UsagePool = 'anthropic' | 'codex' | 'kimi'`.** Every pool is served
  every time, in `USAGE_POOLS` order, so a provider can vanish from the screen
  only by being deleted from that list. Codex has no writer yet (its gauge is
  harvested from real `codex` runs and lands with the lane writers). With no Codex
  credential it renders "Not connected."; WITH one it renders `no_gauge` — "this
  build doesn't meter this provider yet" — and never a row of zeros. `connected`
  would be wrong there: it means "empty because the first reading has not landed
  YET", and no writer records `pool: 'codex'` in this binary (the positive controls
  `pool: 'anthropic'` and `pool: 'kimi'` both appear in `open/composer.ts`), so the
  card would promise a tick from a poller that does not exist. The state disappears
  by deletion when the Codex gauge lands — no flag, no second path.
- **The second gauge — `open/kimi-usage-monitor.ts` + `trident/kimi-usage-probe.ts`.**
  Kimi publishes no rate-limit headers, so its standing is read from
  `GET {KIMI_BASE_URL}/v1/usages` on a 10-minute `SupervisedLoop`, armed
  unconditionally beside the credential probe; the key is read PER TICK from the
  credential store the Settings pane writes, so a key entered now is metered
  without a restart. The endpoint is **account-wide** — two keys on one
  subscription return the same numbers — so per-key attribution is never
  fabricated and the card is titled accordingly. The response schema is not
  published: the parser accepts a written-down alias set and answers
  `unrecognised` (logging the KEY NAMES it saw, never values) for anything else,
  which writes NO row and leaves the card ageing. Units are checked, not trusted:
  a percent above 100 and a fraction above 1 are refused rather than clamped — and
  refusing a PRESENT field never falls through to another alias, so
  `{used_percent: 150, utilization: 0.5}` refuses the entry instead of answering 0.5
  under the broken field's meaning. A percent-named value INSIDE `(0, 1]` is
  ambiguous (`used_percent: 0.85` is either 0.85% or 85%, and dividing anyway is the
  optimistic reading that paints an 85%-spent window as a 1% bar), so it is resolved
  from the SAME payload where that payload proves the scale and refused where it does
  not: a field carrying fractions can never exceed 1, so a sibling window reading
  `used_percent: 64` is positive proof that this response writes percents. The
  inference is one-directional — no fraction payload can produce the evidence — and is
  scoped per payload and per key name. Without it, a healthy 5-hour window sitting at
  1% beside a readable 64% weekly window discarded BOTH windows and painted the
  permanent-fault banner ("check the key, then the logs") on a gauge that was answering
  correctly, flapping in and out of it as the short window crossed 1%. Every reset
  instant is
  plausibility-checked against the clock after conversion, so a seconds value read
  as ms (1970) or an ms value converted again (year 57,000) fails loudly instead of
  rendering. That plausibility bound is ASYMMETRIC, and each side is measured in the
  thing that actually bounds it. Going FORWARD it is ONE WINDOW LENGTH, scaled per
  entry, because a rolling window of length L resets within L and window length is not
  a constant. Going BACK it is CLOCK SKEW and nothing more (five minutes): the current
  window's reset is always ahead of now, so the only legitimate past instant is the one
  that rolled moments ago. Scaling the PAST allowance with the window was itself a
  defect — it let a five-hour window absorb a reset four hours old, and a reset that
  has passed reads downstream as "the window rolled, this account is free", so a
  99%-spent account rendered "1 available now". A PARTIAL read is refused outright for
  the same reason: one unreadable entry — an unmodelled shape, a missing length, or a
  second window landing in an already-filled slot — or a list carrying only ONE of the
  two windows discards the whole response, because nothing downstream can tell a sample
  carrying one window from a provider that only HAS one window, and an account whose
  weekly figure was silently dropped would render as one with no weekly limit at all.
  `KimiUsageSample`'s two windows are non-nullable, so that invariant is a type rather
  than a habit. TRANSPORT OUTCOMES ARE SPLIT BY WHETHER WAITING HELPS: 401/403 is a
  dead key, any OTHER 4xx except 408 and 429 is a `rejected` request — permanent, and
  the likeliest first-install failure given the path is unverified — and a 2xx whose
  content type is not JSON is `unrecognised` carrying that content type, because the
  other shape a wrong path takes is a 200 serving an HTML page. Folded into the
  transient arm, both of those retried every ten minutes forever behind "No readings
  yet.", a sentence promising a reading that could not arrive. Timeouts, 5xx and
  transport failures stay transient, and the card keeps ageing.
- **Staleness is shown, never hidden.** Every reading carries its age, on every
  card, not only the stale ones. A reading older than its pool's deadline
  (`POOL_STALE_AFTER_MS` — each polled pool's cadence plus ONE missed probe of
  grace PLUS the clients' own poll interval, because the deadline is checked on the
  client against a payload refetched every `USAGE_POLL_MS` and a written row can be one
  poll away from being on screen; all three are pinned against the pollers' and the
  clients' own intervals by `open/__tests__/usage-dashboard-wiring.test.ts`) renders
  FLOORED — "≥ 43%" plus
  its age — while its window is still running, and unfloored once the window has
  rolled, because "at least this much" stops being true after a reset. Codex has no
  cadence (its gauge is harvested, not polled) and therefore gets a flat 30-minute
  MAX AGE instead: "no cadence" must never become "never stale", or a three-week-old
  harvested reading would claim "available now" beside a "21d ago" chip. Pace is
  computed **as of the measurement**, never as of the render clock: dividing a
  stale fraction by an elapsed-since-now would report a calmer and calmer burn the
  longer a writer has been dead.
- **Capacity is the WORST window, never the soonest reset.** A FRESH reading is
  believed — rolled (the instant has passed) → available; spent (≤5% headroom) →
  returns at its reset; spent with no instant → unknown; room → available. "Spent" is
  compared on the FRACTION side (`fraction >= 1 - SPENT_HEADROOM_FRACTION`) rather than
  by subtracting, because `1 - 0.95` is `0.050000000000000044` in binary floating point
  and the subtraction form put a window at exactly 95% used one float epsilon on the
  OPTIMISTIC side of a constant whose whole job is to err pessimistic. A STALE
  reading proves only that its window was AT LEAST this spent, and only while that
  same window is still running, so it yields a countdown when it says spent and
  `unknown` otherwise — including when its window has since rolled, where
  consumption restarted and nobody measured what followed. An account's standing is the worst of
  its two, so a 5-hour window resetting in 17 minutes is not reported as capacity
  while the 7-day window is spent for another three days. **And an account with only
  ONE of its two windows measured has no standing at all**: a null window is the
  absence of a measurement, not a measured zero, so ranking the windows that happen to
  be present and reporting that as the account is the same defect reached by the other
  road. The measured half still renders in full and only the capacity claim is
  withheld, with the chip naming the reason. The pool line —
  "1 available now (5h window 75% used)", or
  "Next capacity in 3d 0h (7d window; 5h window 98% used)", or "Next capacity
  unknown" — names the binding window and the other window's utilisation, carries the
  headline account's own headroom even when it IS available (available is a boolean;
  the throughput decision it feeds is not), and counts an account nobody can vouch for
  out loud rather than quietly excluding it. TIES ARE BROKEN BY HEADROOM AT BOTH
  LEVELS, and neither is cosmetic: every `available` standing ranks equal, so inside an
  account the tie names the window closest to constraining it, and across a pool the
  tie names the account with the MOST room. Left to payload order the pool tie kept
  whichever account was measured most recently — so a pool holding one account at 94%
  used and one at 5% headlined the spent one and pointed "Next up:" at it. A window
  whose reset has PASSED counts as fully open in both tie-breaks and is rendered "just
  reset" rather than at its pre-roll percentage, because its stored fraction describes
  a window that no longer exists; ranking it anyway printed "1 available now (5h window
  99% used)" beside a row saying that same window was available.
- **Store the instant, render the delta — and NOTHING on the wire is a delta.**
  The payload carries only facts that do not age: each reading's `measured_at`,
  each window's length, reset instant, pace and projection (both anchored at the
  measurement), and the pool's `stale_after_ms` THRESHOLD. The age, the staleness
  verdict, the "≥" floors and every capacity standing are computed by the clients
  in `projectPool`, on every paint, against their own clock — which ticks on a
  30-second interval. `persistence/usage-samples-store.ts` cannot bake a delta
  because `summariseWindow` takes no `now` at all. That is structural rather than
  reviewed, and it is the difference between a card that ages honestly across a
  dead poller and one that insists "just now, available" for as long as the tab
  stays open: both clients fetch once and hold the payload between fetches.
  `CapacityStanding` is a TAGGED union (`available` / `returns` / `unknown`) rather
  than a nullable number, so a client cannot render "unknown" as "now" by writing
  `if (!ms)`; its `returns` arm carries a strictly-positive `in_ms` computed at
  projection, which is what makes the sentence "capacity in ‹countdown›" unable to
  render "capacity in available now".
- **Serving — `gateway/http/app-usage-surface.ts`, `GET /api/app/usage/dashboard`,
  composed in `open/composer.ts`.** Owner-gated, always 200. Each pool carries a
  `connection` of `connected` / `not_connected` / `no_meter` / `no_gauge` /
  `unreadable`, resolved
  from the SAME functions the rest of the product uses (`kimiConfigured`,
  `resolveActiveCodexHome`, `resolveActiveCredential`) — a per-token API key is
  `no_meter`, not "not connected", because telling the owner to reconnect a
  working account sends them to fix the wrong thing. TWO OF THE FIVE EXIST BECAUSE
  "No readings yet." IS A PROMISE, and each is a case where nothing can keep it.
  `unreadable`: the gauge was asked and its
  answer could not be turned into a reading (a rejected key, a non-auth 4xx from a path
  this build has wrong, or a payload shape it does not model) — the realistic
  first-install failure against Kimi's unpublished schema. `no_gauge`: the credential
  is fine and NOTHING IS POLLING that provider in this build, so no tick is even going
  to be attempted. They are kept apart because they send the owner to different places
  — a refusal is a fault to go and fix, an unshipped phase is not.

  IT IS DECIDED BY THE LIVE PROBE, NEVER BY A CREDENTIAL FILE, and on BOTH pools that
  have a writer. `resolveActiveCredential` answers "is a credential present", which is
  a different question from "does upstream still accept it" and performs no validity
  check — so a revoked Anthropic token resolved as connected forever while its 401
  wrote no sample, leaving the one pool with a shipping writer stuck on "No readings
  yet." So the composer reads `CredentialUsageMonitor.readStanding()` for Anthropic and
  `KimiUsageMonitor.readStanding()` for Kimi, PER REQUEST and never latched, so a card
  recovers the moment a tick succeeds; a transient failure stays `connected` on both,
  because the next tick retries and a dropped packet must not repaint the card.

  THE NOTE IS A BANNER, NOT A REPLACEMENT FOR THE ROWS. Samples are retained thirty
  days, so the refusal that actually happens is a pool that read fine for a week and
  then had its key rotated — behind an "only when the card is empty" gate that card
  kept ageing silently with nothing saying its figures were the last that would ever be
  read. The last known values keep rendering with their age chips beside the sentence.
  An empty refused card still shows no number: loud and empty, never a zero.
  `open/__tests__/usage-dashboard-unreadable-wiring.test.ts` boots the real composer
  against a loopback server answering with an unmodelled body, and
  `open/__tests__/usage-dashboard-lapsed-wiring.test.ts` does the same against one
  answering 401 with a subscription token on disk; both assert the composed payload,
  each with a positive control that a pool nobody asked is not reported unreadable.
- **Both clients — `landing/chat-react/SettingsTab.tsx` (Model usage) and
  `app/app/usage.tsx`,** over the twin clients `landing/chat-react/usage-dashboard-client.ts`
  and `app/lib/usage-dashboard-client.ts`. One card per provider, side by side,
  each in its own unit and never summed: the three providers meter different
  things, so a combined headline would be a number about nothing. No dollar figure
  appears anywhere — the subscription is flat, so a currency value would assert a
  marginal cost the owner does not incur. The formatters are executed side by side
  by `gateway/__tests__/usage-dashboard-client-parity.test.ts`, because a
  divergence there is the failure nobody reports: each screen stays
  self-consistent and the owner gets two different answers about one quota. That
  parity test is also where the CAPACITY POLICY is pinned, because the policy is a
  function of the render clock and therefore lives in the clients: `projectPool` is
  executed on both copies over the same payload at the same instant and the results
  are compared whole.
- **And both screens REFETCH on `USAGE_POLL_MS` (30s), on the same interval that
  advances the render clock.** Computing the deltas at paint is what ages a card
  honestly across a DEAD poller; on its own it is a slow lie in the other direction,
  because a screen that only advanced its clock would walk a HEALTHY install into
  staleness — the Anthropic pool's deadline is two and a half minutes
  (`60_000 × 2 + 30_000`, the constant rather than a round number in prose), so the
  card would floor its gauges and drop capacity to "unknown" that soon after the
  screen opened while a live poller wrote a fresh row every 60 seconds. One timer
  drives both, so the data and the clock it is measured against cannot drift, and the
  parity test bounds the RELATIONSHIP rather than the number
  (`USAGE_POLL_MS × 2 < min(POOL_STALE_AFTER_MS)`, importing the store's own
  deadlines), so a pool cannot get a deadline tighter than the screens can keep up
  with. Each screen has a mutation-checked test: a tick that advances the clock and
  does not refetch turns it red.

  AND THE POLLS ARE SEQUENCED, because they overlap. The interval does not wait for
  the previous response, so two requests are routinely in flight together and a slow
  one settling LAST would win by arriving late — repainting a reading already known to
  be superseded, wearing the newer one's age chip. That is fabricated freshness, the
  one class this surface exists to prevent, reached from the client side. Each load
  takes a generation number and a superseded response is dropped rather than rendered.
  A counter rather than an `AbortController`: a late reading is still a good reading
  and the next tick is seconds away, so there is nothing to gain by cancelling it —
  only a discarded one to avoid painting. Both screens pin it with two gated responses
  released newest-first, and removing the guard turns each red.

## Message search (chat-history FTS) — `@neutronai/chat-core` + `@neutronai/message-search`

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

## External system notice — `POST /api/app/system-notice` → the `deliver` seam

`gateway/http/deliver.ts` is the ONE out-of-turn delivery seam: everything that
posts to the owner OUTSIDE a request/response turn — fired reminders, the morning
brief, idle nudges, ritual-approval prompts, the substrate notice bubbles, Skill
Forge proposals — goes
through `deliver(topic_id, envelope)`, which owns durable-row-first persistence
and a best-effort live push routed by topic grammar. Every one of those producers
is IN-PROCESS. Until this surface existed, **nothing could reach that seam from
outside the process**, so a caller that knew something the owner needed to know
had no way to say it: it could restart the box, but not explain why.

`POST /api/app/system-notice` (`gateway/http/system-notice-surface.ts`, served via
the `appSystemNotice` slot in `route-slots.ts`) is that one route. It adds a
caller to the existing seam and builds no delivery mechanism of its own.

- **Request.** `{"body": "<text>"}` with `Authorization: Bearer <token>`. The
  body is the finished sentence and is delivered verbatim. Capped at the same
  16 384 chars the chat transport enforces on a user message.
- **Response.** `200 {ok, prompt_id, delivered_live}`. `delivered_live: false` is
  still a success — it means no socket was open, which the durable row covers.
  A durable-persist failure is a `503 delivery_failed`, never a 200 for a message
  the owner will never see.
- **Auth is the existing instance-scoped bearer, with nothing added.** The same
  `AppWsAuthResolver` every other `/api/app/*` surface uses. In the production
  `jwks` mode: RS256 against the identity service's published keys, unexpired, a
  non-empty `sub`, and a `slug` claim constant-time-equal to THIS instance's slug
  — an account-scoped bearer carrying no `slug` is refused outright. That slug
  check is the authorization; a token minted for another install cannot post here.
  The bar is higher than on a read surface because a caller who reaches this route
  writes a durable line into the transcript that renders as the system speaking.
- **Durability is `'inert'`, deliberately not `'none'`.** The substrate sink's
  transient `'none'` pill writes no row, so a client not connected at that instant
  never learns it happened — and an out-of-band announcement is precisely the case
  where the owner is not watching. `'inert'` persists an already-resolved agent
  history turn (`ButtonStore.persistInertAgentTurn`, speaker `__system__`), so the
  notice is in the transcript when he next opens the app, and it never becomes the
  active prompt his next message attaches to.
- **It is a system message, not the owner speaking.** It does NOT route through
  `POST /api/app/chat/send`, which would persist a `role: 'user'` turn and
  dispatch an agent turn from it — fabricating words the owner never said and
  spending a model turn to announce something that needs no reasoning.
- **The topic is fixed at composition.** `open/composer.ts` hands the surface the
  bare `app:<owner>` topic (the one the live client binds AND hydrates); the
  caller supplies text and nothing else, so the route cannot be aimed anywhere but
  the owner's own chat.
- **It carries no vocabulary of its own.** There is no `reason` enum, no event
  taxonomy, no per-source formatting. Whatever a given deployment wants to
  announce is that deployment's concern, not the engine's.

## Delivery + read receipts (Track B Phase 4) — `@neutronai/chat-core` + app-ws

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
  delivery status line. **Wired live in Open as of 2026-06-29** — see the
  "Durable chat transport" subsystem note below; `receipt_log` (and `chat_log`,
  `reaction_log`, `edit_log`) are now constructed in `open/composer.ts` and
  passed to the adapter, so the ladder is live, not test-only.

## Durable chat transport (Telegram-class) — `open/composer.ts` wiring + real typing (2026-06-29)

The single root cause behind a cluster of "feels broken" M1 chat gaps was that
Open's composer constructed the app-ws adapter with **no durable logs**
(`new AppWsAdapter({ registry, receiver })`), so `hasChatLog === false`
everywhere and all the (already-built, already-tested) seq / resume /
idempotency / receipt / reaction / edit machinery in the adapter + surface was
**inert**. The fix wires the foundation in + adds a server-authoritative typing
indicator. No feature flags — one live path.

- **The wiring (`open/composer.ts`).** The adapter is now constructed with all
  four per-topic logs, each backed by the single-owner `project.db`
  (`new AppChatStore({ db })`, `AppChatReceiptStore`, `AppChatReactionStore`,
  `AppChatEditStore`; migrations `0079/0082/0083/0087`). This single change flips
  `hasChatLog`/`hasReceipts`/`hasReactions`/`hasEdits` true and lights up the
  surface handlers (`gateway/http/app-ws-surface.ts`) that were already present:
  - **#1 durable chat_log + monotonic per-topic `seq`** on every user echo +
    agent reply (`app_chat_messages`), stamped on the wire.
  - **#2 idempotent ingest on `client_msg_id`** — the retry button + the WS↔HTTP
    fallback race re-send the SAME id; `ingestUserMessage` returns
    `was_new:false`, and the surface's `if (!was_new) return` guards skip the
    chat-command filter AND the agent dispatch, so a re-send NEVER re-runs the
    turn (no dup reply, no double LLM spend, no double Bash/Write/Edit side
    effects).
  - **#3 gap-free reconnect** — `session_ready.last_seen_seq` + a
    `{type:'resume',after_seq}` replay of everything after the client's cursor,
    so a reply emitted during a socket blip is recovered (no orphaned "hung"
    reply).
  - **#4 receipts / reactions / edits** — persisted + fanned as `receipt_update`
    / `reaction_update` / `edit_update`, replayed on resume.
  - **#4b answered prompts (ISSUES #415 + #419)** — a `button_choice` is CLAIMED
    before it dispatches (`claim_button_prompt` → `ButtonStore.resolve`'s
    `was_new`), so a re-tap never re-runs the agent; and the claim then STAMPS
    the answer onto the agent message that carried the prompt
    (`AppChatStore.markPromptChosen` writes `chosen_value` into the row's `meta`,
    first-write-wins) and fans a `prompt_resolved` frame
    (`{v:1,type:'prompt_resolved',message_id,prompt_id,chosen_value,seq?,ts}`).
    Clients apply it via `SyncEngine.applyPromptResolved` and render spent-ness
    through the ONE shared `spentChoiceValue` rule in `@neutronai/chat-core`.
    Both halves are needed: the frame corrects a live device immediately, the
    stamped `chosen_value` rides the ordinary replay so a remount, cold open,
    reinstall or second device draws the row spent too. Reply rows carry a
    TEN-YEAR TTL, so without this a Retry button resurrected by any remount drew
    as live forever on a prompt the server already refused to honour.
- **#5 fire-and-forget send (`gateway/http/app-ws-surface.ts`).** The HTTP
  `/api/app/chat/send` fallback used to `await dispatchInbound` (the whole turn,
  up to 240s) before responding, so the optimistic bubble couldn't confirm and an
  RN/proxy timeout flipped it to `failed`. It now returns the durable echo (with
  `seq`) IMMEDIATELY and runs the turn in the background; the reply fans over the
  WS and is replayable from the chat_log.
- **#6 real, server-authoritative typing (`AppWsOutboundAgentTyping`).** A new
  ephemeral `{v:1,type:'agent_typing',state:'start'|'end',ts,project_id?}` frame
  is fanned directly (NOT persisted, no seq, never replayed) around every
  app-ws live-agent turn (`emitAppWsTyping` brackets each `appWsChatTurn` await —
  steady-state typed turns, tapped quick-replies, and the onboarding seed). Unlike
  a client-side optimistic guess, this is driven by the gateway actually picking
  up + finishing the turn, so WARM turns (every turn after the cold first one) get
  a real "replying…" affordance for their full duration. The legacy `web:` path's
  `agent_typing_start`/`agent_typing_end` is the prior art; this collapses it into
  one app-ws envelope with a `state` discriminator.
  Typing tracks the live TURN, not the presence of streamed text. It is
  level-triggered when a socket connects and edge-triggered thereafter:
  `on_session_open` reads the same `activeChatProjects` set as the project rail and
  sends a catch-up `start` only to that socket when its scope is working, so turn
  state is resynchronised on connect even when no text partial has arrived. The
  catch-up is a read, not a refcount transition, so it neither changes nesting nor
  extends the fail-safe. It still bypasses the durable adapter: typing describes
  only the live present and must never enter history or a `resume` replay.
- **#7 live history-import progress (`AppWsOutboundImportProgress`).** A long
  ChatGPT/Claude import (minutes, for hundreds of conversations) previously showed
  no live progress on the app-ws surface: the engine's `import-running-cron` emits
  an `import_progress` event every ~5s, `buildRoutedSendImportProgress` routes
  `app:<user>` topics to a composer holder — but that holder's `.send` was a
  documented NO-OP (`open/composer.ts`), so every frame was dropped and the chat
  stalled on a one-shot "received" banner. The holder now fans an ephemeral
  `{v:1,type:'import_progress',job_id,status,pass,pct,chunks_total_known,body?,ts}`
  frame via `appWsRegistry.send` (NOT persisted, no seq, never replayed — mirrors
  `agent_typing`/`work_board_changed`). The React client already consumed it
  (`controller.ts`) and renders a live spinner + per-pass progress line
  (`ChatApp.tsx` `ImportStatus`), so a long import visibly works, then the
  proposed-projects analysis renders. Engine/cron/client-render were already built
  — this fix was wiring the dropped `app:` route + defining the wire envelope (M1
  live-test, 2026-06-29). The legacy `web:` path's `import_progress` `ChatOutbound`
  frame is the prior art.
- **Clients render it on both surfaces.** Web (React/assistant-ui via chat-core
  `web-session` → `controller.ts`) already resumed + rendered receipts/reactions/
  edits; it now drives its `car-typing` indicator off the authoritative
  `agent_typing` frame (optimistic-on-send retained as a fallback). **The Expo
  app now has exactly ONE native chat surface: `ChatSyncSurface` IS the Chat tab**
  (`app/projects/[id]/chat.tsx` is a thin route that renders it). The 2026-06-29
  chat-collapse deleted the legacy streaming surface and its transport
  (`chat.tsx` body, `chat-state`, `ws-client` (legacy `AppWsClient`), `MessageItem`,
  `ConnectionBanner`, `chat-deep-link-navigator`, and the separate `chat-sync`
  sub-route) — no dual path, no flag. `ChatSyncSurface` runs on the durable
  chat-core transport (offline send, gap-free resume, receipts/reactions/edits,
  typing) and renders the full agent surface (markdown, attachments/inline images,
  citations, doc-ref deep-links, onboarding option buttons / image-gallery, upload
  affordance) plus the ported input/upload pipeline (InputComposer + UploadModal +
  web drag-drop + ZIP/image upload). Slash-command answers (`chat_command_result`)
  render as agent messages on this surface too.
- **Bubble width: ONE cap, in one place (`app/lib/chat-bubble-metrics.ts`, 2026-07-29).**
  `bubbleColumn` carries `maxWidth: BUBBLE_MAX_WIDTH` (90%) and nothing else in the
  chain does — every row, including the streaming bubble and the typing indicator,
  renders through that column. Two percentage caps in one chain **multiply** in Yoga:
  a node's `availableInnerWidth` is clamped by its own resolved `maxWidth` and that
  clamped value becomes the child's `ownerWidth` for percentage resolution
  (`react-native/ReactCommon/yoga/.../CalculateLayout.cpp:519-527`, `:1397-1404`), so
  the shipped `bubbleColumn` 82% wrapping `bubble` 82% was an effective 67% and a
  reply wrapped after ~5 words on device. 90% rather than the phone-chat-typical ~78%
  because `ProjectRail` is a permanent 72pt column and the transcript adds a
  `SPACING.md` gutter each side, so the percentage applies to a row (297pt on a 393pt
  phone) that is already narrower than an iMessage bubble is allowed to be; 90% keeps
  a ~30pt far-side gutter, which is what carries the left/right speaker distinction.
- **Bubble RHYTHM is a function of the sender, not a constant (same module, 2026-07-30).**
  `bubbleWrap` used to carry a uniform `marginVertical`, i.e. identical space between
  every pair of bubbles — which is exactly what does not happen in iMessage, where the
  only gap the eye registers is the SENDER CHANGE. `bubbleGapPt(previous, current)`
  now returns 2pt inside a same-sender run, 8pt at a change, 0 at the head of the list,
  applied per row as `marginTop`; `bubbleHasTail` gives one tail corner per RUN rather
  than one per bubble. Bubble padding came down to 6pt vertical, and the delivery tick
  moved OUT of the bubble and down to the newest outgoing message only (a `failed`
  send is exempt and always shows, because that glyph is the retry affordance). The
  tick rendering inside every outgoing bubble was most of the bottom padding Ryan kept
  pointing at.
- **The composer clears the keyboard AND the home indicator, never both at once
  (2026-07-30).** `keyboardOverlap` handles the keyboard (2026-07-29). The other state
  had no owner: `react-native-safe-area-context` was a declared dependency of `app/`
  with zero imports, and the project shell hard-codes its top inset and applies no
  bottom inset, so the surface runs to the physical bottom of the screen and the
  composer's fixed padding sat under a 34pt home indicator. `composerBottomInset`
  (`app/lib/keyboard-inset.ts`) adds the safe area ONLY while the keyboard is down —
  with the keyboard up the surface is already lifted by the full overlap and the
  keyboard covers the indicator, so adding it again floats the bar over dead
  background. `InputComposer` takes it as `bottom_inset`.
- **The cold-start ack is a TRANSIENT pill on mobile too, and the predicate is shared
  (2026-07-30).** #333 made the "⏳ Waking up…" ack live-only on the wire. The web
  client routed it to a separate `systemNotice` channel — but via a PRIVATE function
  inside `landing/chat-react/controller.ts`, so the native client, which shares
  `chat-core` and not that file, had no such behaviour at all: `normalizeInbound`
  turned the ack into an ordinary `ChatMessage` and the on-device store kept it
  forever (it survives a reload, and the resume replay can never reconcile it because
  the server has no such row). `isColdStartAck` / `isTransientSystemNotice` /
  `systemNoticeText` now live in `chat-core/types.ts` and BOTH surfaces import them —
  one mechanism, not two. `MobileChatSession.handleInbound` drops a transient frame
  before persisting; `foldSystemNoticeFrame` mirrors the web clearing rules including
  the FIX #347 late-ack latch; `ChatSyncSurface` renders it as a centered pill in the
  list footer. The fold runs BEFORE the project filter deliberately — the ack carries
  no `project_id`, so `frameMatchesProject` would drop it in every project view, and
  the socket is already scoped to one topic.
- **Activity inspector reachability (2026-07-30).** `ActivityInspectorDrawer`'s header
  used a hard-coded 32pt top padding — shorter than the notch on every modern iPhone —
  over a ~24pt close target. Now `safeArea.top + SPACING.sm` and a full 44pt HIG
  target (`MIN_TAP_TARGET_PT`) with `hitSlop`; event rows came up off 11pt monospace
  to 13/19, and the row list takes the bottom safe area.
- **Client ids: `chat-core/ids.ts` `randomId()`, and NOTHING may call WebCrypto
  directly (2026-07-29).** `crypto` IS NOT A GLOBAL on the mobile runtime — RN 0.81
  installs none and Expo SDK 54's WinterCG shim stops at `TextDecoder`/`URL`/
  `structuredClone` (`expo/src/winter/runtime.native.ts`). `SendQueue`'s default id
  generator called `crypto.randomUUID()`, so `enqueue()` threw before writing the
  optimistic row and mobile chat had **never delivered a single message** — no
  bubble, no frame, no server row, no log, because `use-mobile-chat` swallowed the
  rejection with `void`. Six other client call sites had each hand-rolled the same
  guard; the seventh, on the send path and shared with the browser where the bug is
  invisible, did not. Now: one generator
  (`crypto.randomUUID` → `getRandomValues` → `Math.random`, never throws), and
  `chat-core/__tests__/no-direct-webcrypto.test.ts` fails the build on any direct
  WebCrypto call in `chat-core/`, `app/lib`, `app/app`, `app/components` or
  `landing/chat-react`.
- **The connection is ASSUMED GOOD until it has been bad for a while (2026-07-31).**
  `app/components/ConnectionNotice.tsx` replaced the strip that transcribed the
  `ConnStatus` machine ("Connecting…" on every mount, i.e. on every project switch).
  It now renders nothing for a connect or a reconnect, and shows a single quiet
  `Offline` line (with the queue depth, when sends are stacked up) only after
  `OFFLINE_NOTICE_AFTER_MS` — 15 s, matching `ChatWsClient`'s `maxBackoffMs`, so five
  backoff rounds have failed before the owner is told anything. The deadline keys on
  boolean health, never the status string, so a flapping outage still surfaces and a
  recovered socket clears the notice on the same render. Per-message truth stays on
  the bubble's 🕓/✓/⚠️ delivery glyph.
- **A send that cannot be queued is VISIBLE (2026-07-29).** `useMobileChat.send`
  returns `Promise<boolean>` and sets `sendError`, which `ConnectionNotice` renders
  above the transcript, instantly and undelayed; `InputComposer` keeps the owner's
  draft when it is false. A
  null session reports "Still connecting" instead of silently no-oping. The old
  `void session?.send(...)` made every send failure indistinguishable from success,
  which is what made the WebCrypto bug undiagnosable rather than merely present.
- **Keyboard avoidance is MEASURED, not `KeyboardAvoidingView` (2026-07-29).**
  `app/lib/keyboard-inset.ts` + `use-keyboard-inset.ts`: the surface's bottom edge is
  read with `measureInWindow` (WINDOW coordinates, same space as the keyboard's
  `endCoordinates.screenY`) and the overlap is applied as `paddingBottom` on an inner
  child of the measured view. `KeyboardAvoidingView` measures itself PARENT-relative,
  so nested under the shell's status-bar padding + `ProjectHeader` + `ProjectTabBar`
  it under-padded by ~150pt — more than the composer's height, so the keyboard
  covered the input entirely. The measured form is correct at any nesting depth and
  self-corrects on Android (`adjustResize` shrinks the window first → overlap ≤ 0 →
  no padding, no platform branch). iOS subscribes to `keyboardWillChangeFrame`, which
  covers show/hide/height-change/interactive-dismiss in one listener and fires before
  the animation.
- **Verified on a real instance.** `open/__tests__/open-app-ws-durable-chatlog.test.ts`
  boots the REAL Open composition over `Bun.serve`, opens `/ws/app/chat`, and
  asserts #1–#6 on real (mocked-substrate) turns: echo+reply carry `seq` and
  persist; a re-sent `client_msg_id` does NOT re-run the turn; a 2nd socket
  resumes a gap-free transcript with `last_seen_seq`; the agent-read
  `receipt_update` fans; the HTTP send returns the echo before the (delayed) turn
  finishes; and a real `agent_typing` start→end bracket arrives.

> **P1b (2026-06-26) — the app-ws surface IS now wired into the single-owner Open
> boot.** `open/composer.ts` constructs `InMemoryAppWsSessionRegistry` +
> `AppWsAdapter` (with a hand-rolled receiver that runs `buildLiveAgentTurn` and
> fans the reply via `adapter.send`) + `createAppWsSurface`, and returns
> `app_ws_surface` + `app_docs_surface` in the CompositionInput, plus `cores.auth`
> for the `/api/cores/*` admin endpoints. So a fresh Open install serves working
> React chat (`/ws/app/chat`), Documents (`/api/app/projects/<id>/docs`), and
> admin endpoints — all behind ONE single-owner localhost-trust `AppWsAuthResolver`
> (`bypass:true`; the owner is the sole 127.0.0.1 user, already HTTP-authed).
> **(2026-06-29: `chat_log`/`receipt_log`/`reaction_log`/`edit_log` are now ALL
> wired in Open — durable seq, resume, idempotent retry, receipts/reactions/edits
> are live. See "Durable chat transport" below.)** Managed layers its own auth as
> the thin wrapper.

> **P1b consolidate (2026-06-26) — `/ws/app/chat` is now the SINGLE chat WS
> endpoint; onboarding is its INITIAL MODE.** The legacy `/ws/chat` onboarding
> socket + its chat-bridge websocket handler are deleted (`landing/server.ts`
> serves the SPA + HTTP only). The shared `InterviewEngine` (keyed on
> `(project_slug, user_id)`, transport-agnostic) now emits over app-ws: a new
> `app:` prefix in `buildRoutedSendButtonPrompt`/`buildRoutedSendImportProgress`
> (via a composer-filled holder) translates each engine `ButtonPrompt` into the
> app-ws `agent_message` superset (which already carries
> options/prompt_id/allow_freeform/kind/upload_affordance). The surface gains
> `on_session_open` + `on_button_choice` (a structured `button_choice` inbound).
> **(Superseded by Path 1, 2026-06-27: every onboarding turn — typed or tapped —
> now runs through `buildLiveAgentTurn` (the live CC session) with an onboarding
> preamble + post-turn scribe; the `isOnboardingActive()→engine.advance` branches
> were removed, `on_session_open` seeds the first live-session turn, and the
> engine is retained only as the import subsystem. See the "Onboarding runs AS
> the live CC session" note above.)** The React client
> (`chat-core` + `chat-react`) preserves + renders the button metadata
> (`ButtonOptionRow`/image-gallery) and posts the choice back — onboarding runs
> inline in the same chat surface, no special client path. The **web admin panel**
> (`IntegrationsTab` + `integrations-client` over `/api/cores/integrations` +
> `/api/cores/api-keys/<label>` + `/api/cores/oauth/google/{start,disconnect}`)
> surfaces the global `admin` tab in the web ProjectShell. Google accounts are
> MANAGED there, not merely displayed: rows are grouped by service
> (`integrations-oauth-view.ts`), each connected account carries its own
> Disconnect, and a service that already holds accounts still offers "Add another
> account" — the owner runs several Google accounts, so one row per service would
> strand the second and third. Connect does the AUTHENTICATED `/start` fetch and
> then navigates to the `authorize_url` it returns; `/start` is bearer-gated, so
> it can never be rendered as an `<a href>` (that 401s).
> Verified in a real headless Chromium (system Playwright):
> `tests/e2e-browser/onboarding_walkthrough.py` (CI-skippable) — `/chat` → React →
> fresh onboarding renders + advances over the single socket; Documents + Admin
> tabs render.

## Message reactions (Track B Phase 4, slice 3) — `@neutronai/chat-core` + app-ws

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

## `/code` → foundational Trident (runtime DONE — runner live + hardened)

### Trident v2 (Phase 2a exec-model) — OUTER durable loop FIRES the INNER CC Dynamic Workflow + HARVESTS from the DB

**As of Work Board Phase 2a the OUTER loop FIRES the inner workflow and SETTLES
the launching turn immediately, then HARVESTS the workflow's typed terminal
result from the DB** (NO feature flags — a hard cutover; the `claude -p`
print-mode launcher and #123's sibling+held-open variant are SUPERSEDED and
deleted, no dual path):

- **OUTER (durable):** `trident/tick.ts` sweeps the `code_trident_runs` SQLite
  table (migration 0077) and calls the orchestrator `step` per run. State in
  SQLite ⇒ restart-safe + resumable. Merge stays the OUTER / human gate
  (`trident/merge.ts`), and the Ralph spec-drift docs are unchanged.
- **INNER:** `trident/inner-workflow.mjs` is ONE CC Dynamic Workflow (run by the
  `Workflow` tool) that drives **Forge build (isolated worktree) → parallel
  adversarial Argus review → asymmetric-gated synthesis → bounded fix loop →
  verdict**. The Forge/Argus contracts are INLINED into the workflow's bare
  `agent()` workers (no CLAUDE.md rides along), each carrying a
  `NO_INTERACTIVE_RULE` (never `AskUserQuestion`; ABORT instead of hang) and a
  `REDIRECT_RULE` (redirect verbose build/test output to a log, read only the
  tail). `state-machine.ts` (`computeTransition`/`advanceTridentRun`) is kept
  intact for its unit tests + revertibility.
- **FIRE + SETTLE (the exec model):** `trident/inner-loop.ts` `buildWorkflowFirer`
  fires the workflow via a FIRE seam (`buildSubstrateWorkflowFire`) — ONE turn on
  a **WARM, NON-EPHEMERAL** substrate that invokes the `Workflow` tool and then
  `reply()`s. The launching turn SETTLES in seconds while the workflow keeps
  building in the BACKGROUND; because the substrate is warm (not disposed on
  settle), the detached workflow survives, and ONE warm substrate can hold N
  background workflows at once. This is **billing-exempt** — the warm substrate
  runs on the owner's Max-OAuth pool, NOT a per-build API-billed `claude -p`. The
  fire is `fired` ONLY on a clean `completion` event (**false-completion
  discipline** — a settle-timeout / error / stream-closed-without-completion is
  `failed`, never a silent success). The fire substrate declares EXACTLY
  `WORKFLOW_FIRE_TOOL_NAMES = ['Workflow']` (the Forge/Argus/Bash work all runs
  inside the workflow's own nested agents, not on the launcher turn).
- **HARVEST FROM THE DB (not stdout):** with the launching turn settled and the
  workflow detached, there is NO process capturing stdout. The workflow persists
  its TYPED terminal result (`{ok,prNumber,branch,verdict,round,checkpoint}` as
  compact JSON) to `code_trident_runs.inner_result` (migration `0091`) via its own
  `agent()` Bash step (`printf` the JSON to a temp file → `readfile()` CAST AS
  TEXT, so the JSON's double quotes can never break the sqlite shell argument).
  The orchestrator `step` HARVESTS that row by `runId` each tick: `parseInnerResult`
  decodes the typed column (non-null = harvest-ready), then it advances the state
  machine deterministically in TS — never an LLM-parsed line.
- **A REVIEWER THAT DIES IS A BLOCKED ROUND, NEVER A DEAD LANE:** every review seat
  is dispatched through ONE chokepoint, `seatAttempt` in
  `trident/inner-workflow.mjs` (both core reviewers, `argus:codex`, `argus:kimi`,
  `argus:synthesis`, the CI probe, the branch-head probe). Every way a seat can fail
  to produce a usable verdict — a rejected promise (an API 529, a timeout), a
  synchronous throw, a subprocess exit, a null/undefined/non-object reply, an object
  with no `verdict` — collapses to the SAME `null` the panel already handles:
  `retryDeferredPeers` re-dispatches the seat once (bounded, because a 529 is
  transient), and a seat still empty after that is declared missing, blocked by
  `enforceCrossModelGate` with a finding NAMING the seat, and classified
  `infra-only` so the loop stops instead of re-Forging against nothing.
  `reviewRoundOrInfraBlock` is the outer half of the same guard: a review round may
  not throw, whatever else inside it does. The failure direction is always a BLOCK —
  the only value invented is `null`, which is not a verdict — so a panel that lost a
  seat can never merge (the cross-model rule in `trident/kimi-review.ts`: a review
  that did not happen may never become an APPROVE, and never falls back to a
  Claude-family model). Before this, one dying reviewer ended the whole lane at
  `checkpoint: 'inner-error'` with no verdict, discarding a finished build and every
  review already paid for.
- **SERVER-GATED verdict provenance:** a merge-eligible `APPROVE` is honoured ONLY
  when the Argus phase's OWN recorded `inner_checkpoint = 'argus-approved'` (written
  by the synthesis-phase Bash step) backs it — a self-asserted `APPROVE` in the
  result line with no recorded provenance is REJECTED to `failed`, never merged.
- **A MERGE IS TERMINAL (ISSUES #563):** the run lifecycle ENDS where the change
  ships. The inner loop probes the PR's merge state the instant a Forge round
  returns — ahead of the review panel, the Ralph re-fire, the round-1 empty-build
  refusal and any round increment — and a merged PR ends the run right there
  (`inner_checkpoint = 'pr-merged'`, result `{prMerged:true, verdict:'APPROVE',
  blockKind:'none'}`, no `reviewedHead`). It had to be probed rather than signalled:
  the loop-continuation decision is the fix loop's `while` condition (verdict /
  round / blockKind — no fact about the PR in it) while the merge is performed by a
  DIFFERENT component (`orchestrator.applyResult` → `cleanupAfterMerge` → `mergePr`,
  strictly after this workflow's result is harvested) or by an agent INSIDE the run,
  and the workflow never re-reads its own row (`checkpoint.sh` only WRITES). Before
  this, a lane that merged spent roughly another review cycle — measured at ~19
  minutes — fixing a branch the merge had deleted, silently: a merged PR is green,
  so nothing downstream complains. The OUTER loop reads `pr_merged` BEFORE the
  verdict branches and finishes the run WITHOUT touching the remote (a second
  `gh pr merge` on a merged PR fails, which would record a shipped change as
  `merge failed`). Only GitHub says "merged": one fixed `gh pr view <n> --json
  state,mergedAt`, classified in JS, where unreadable is `unknown` — never "merged"
  and never "not merged".
- **…and a deleted branch is NOT a lost round (#563 × Open #148):** the round-lost
  guard decides by reading the branch head, and a merge DELETES the branch, so a
  merged run presents to it as the failure it exists to catch. `roundOutcome`
  (`inner-workflow.mjs`) is the one place the two are ordered: the merge question is
  asked BEFORE any `round-lost` verdict is written, and only a non-merge lets the
  head comparison speak. The guard's behaviour for a fix round that genuinely never
  pushed is unchanged.
- **Per-phase SQLite checkpointing (C1) + idempotent crash-resume (C2):** the
  workflow's own `agent()` Bash steps `UPDATE code_trident_runs` mid-run
  (`inner_checkpoint` = `forge-done` / `argus-approved` / `argus-request-changes`
  / `fix-round-N`; timestamps via `date -u +%FT%TZ` since `Date.now` is
  unavailable in a workflow). A workflow is session-bound (`resumeFromRunId` is
  same-session only) and the background workflow does NOT survive a process exit,
  so **the tick loop owns liveness**: a persisted `subagent_run_id` THIS process
  never fired + no `inner_result` yet is an ORPHAN → re-fire a FRESH workflow that
  reads the checkpoint, skips finished phases, and REUSES the existing PR (`gh pr
  list --head` — never a duplicate / double-merge; a merged run is terminal so is
  never re-fired). A workflow whose `inner_result` is already written harvests
  deterministically across restarts (the result lives in the DB, not memory); a
  fired workflow that goes silent past `max_inflight_ms` (default 2 h, measured
  from the checkpoint-refreshed `last_advanced_at`) is reaped as stalled.
  Migrations `0089` (`workflow_run_id` / `inner_checkpoint` / `inner_verdict`) +
  `0091` (`inner_result`, the harvest signal — WORKFLOW-OWNED; the orchestrator
  only ever reads it, never writes it, so a launch `save()` can't clobber the
  detached workflow's out-of-band write).
- **Orchestrator surface:** `Workflow` is now on the live-chat agent's constant
  `DEFAULT_TOOL_NAMES` (`build-live-agent-turn.ts`) so the owner's orchestrator
  REPL can fire background tridents directly + stay responsive (readies the
  board-bound direct-fire in Phase 2b). The exec-model launcher itself fires via
  the dedicated warm `cc-trident-fire-*` substrate (one warm pool entry per repo
  cwd, since the persistent pool keys on instance not cwd, and the workflow's
  `isolation:'worktree'` forks from the fire turn's git cwd).
- **Worktree cleanup ENFORCED (D-1/C3):** the workflow's `finally{}` runs the
  checked-in `trident/worktree-cleanup.sh` against the deterministic
  `trident/<slug>` branch on every path (independent of Forge's return value —
  the harness only auto-cleans an UNCHANGED worktree, and a Forge build always
  commits). `merge.ts` adds the OUTER backstop (best-effort `git worktree remove`
  + `prune` after a landed merge), flipping the old "NO `git worktree remove`"
  lock.
- **…but cleanup is NEVER destructive (ISSUES #541):** that `finally{}` also
  fires on THROW and ABORT — exactly when Forge died mid-edit — and it used to be
  a cheap-model agent told to "ignore individual command failures" while running
  `git worktree remove --force` + `git branch -D`. On PR #171 it destroyed 197
  insertions across 7 files. The decision is now deterministic shell with no LLM
  judgement in it: a worktree that is DIRTY (uncommitted changes **including
  untracked files**) or unverifiable is PRESERVED, its paths printed, exit 3; a
  clean one is removed with a plain `git worktree remove` (no `--force`, so git's
  own dirty check is a second gate); the pr-mode `git branch -D` runs only once
  `git ls-remote` proves origin holds the same sha (local mode never deletes it).
  `merge.ts` applies the same gate to every worktree removal it does, and fails
  the merge with "trident PRESERVED uncommitted work at `<path>`" rather than
  letting git's raw "already checked out at `<path>`" be the operator's notice.
  Preserve-by-default only works if it never cries wolf, so: git's stderr is kept
  out of both probes (a warning on a clean tree is not a dirty path), the SHARED
  CHECKOUT is skipped entirely (git refuses to remove a main working tree, and
  `merge.ts` legitimately parks it on a feature branch — a branch it still holds
  is reported `KEPT … reason=checked-out` at exit 0), the dirt probe requires
  `rev-parse --show-toplevel` to name the path itself **in both copies** (else a
  registered path that has stopped being a worktree root reports the enclosing
  repo's dirt as its own; the shell says `SKIPPED … reason=not-a-worktree-root`),
  and **only exit 3** means preserved work — 2 is a usage error, 127 a bad script
  path, and the caller reports those as a cleanup FAILURE that inspected nothing.
  The gate also cannot break itself: the script's output is capped (a 20k-line
  dirty tree would push the `RESULT` line out of the transcribing agent's window
  and invert the alarm), the exit code is read from two sources so a string `"3"`
  or a dropped field still counts, and the lone network call (`ls-remote`) runs
  with `GIT_TERMINAL_PROMPT=0` plus a `timeout` deadline so a black-holed origin
  cannot hang a `finally{}` nobody is watching. A preserved DIRTY merge worktree
  does wedge every retry — the path is run-keyed and stable — which is the
  deliberate trade: a wedged merge is recoverable, a force-removed conflict
  resolution is not, and the error names the path and the way out.

**Prod-boot wiring — what's live in the Open self-host gateway:**

- **The production runner (LIVE + hardened).** The Open composer
  (`open/composer.ts`) threads `composition.trident = { fire_inner_workflow }` (a
  warm-substrate FIRE seam built over a memoized per-cwd `cc-trident-fire-*`
  factory), which flips the tick loop from its `stubAdvanceDeps` no-op to the real
  `buildWorkflowFirer` + `buildTridentOrchestrator` step in `build-core-modules.ts`
  (passed the project `db_path` for the workflow's checkpoint + terminal-result
  Bash steps). On a server-gated APPROVE the step merges + cleans up; on
  REQUEST_CHANGES (maxRounds exhausted), a provenance-gate rejection, a stalled
  workflow, or a fire that never settled it fails loudly.
- **Billing-exempt + responsive (DONE).** The fire substrate is WARM
  (non-ephemeral) so the launching turn settles immediately and the detached
  workflow runs on the owner's Max-OAuth pool — NO per-build `claude -p` (the
  whole reason for the rearchitecture). One warm `cc-trident-fire-*` REPL per repo
  carries N background workflows in parallel and stays responsive. The workflow's
  Forge agent still gets its OWN `isolation:'worktree'` worktree, so one build
  never inherits another's working context. **Paused ≠ finished (false-completion
  guard):** a fire turn whose stream ends WITHOUT a terminal `completion` event
  maps to `failed`, never `fired` (Open analog of the legacy harness's fleet "paused vs
  finished" reap fix #160). The inlined Forge contract still hard-rules cross-model
  review as **best-effort, after the PR is open, never a turn-yielding hang
  point** (Open analog of the legacy harness PR #164). See
  `docs/research/legacy-neutron-fix-reconciliation-2026-06-24.md`.
- **One-commit revert runbook.** Migrations 0089/0091's columns are additive +
  nullable, so a `git revert <sha>` leaves them harmlessly unused.
- **Phase 2b (DONE):** every trident/agent dispatch is now BOUND to a Work Board
  item at a required-`board_item_id` chokepoint (`trident/board-dispatch.ts` for
  builds — shared by `/code --item` + the agent-native `work_board_dispatch_build`
  tool; `agent-dispatch/service.ts` for `dispatch_agent`/`/dispatch --item`). A
  dispatch without one is REJECTED; an underspecified item (no design doc + terse
  title) is BLOCKED by the ask-before-acting gate (`work-board/dispatch-readiness.ts`).
  Success binds the run (`attachRun` → `linked_run_id` + in_progress → fork `⑂`); the
  durable loop's `on_terminal` reconcile (`trident/board-reconcile.ts`) clears the
  binding + sets the lane (done / back-to-upcoming) on terminal. N builds = N
  board-bound runs the loop harvests in parallel. See the Work Board section above.
- **The `/code` command surface (NEXT PR).** Routing the literal `/code`
  keystroke from the Open landing chat into `buildTridentCodeChatCommandFilter`
  is NOT yet wired — the landing chat path (`landing/server.ts` →
  `chat-bridge.ts:handleInbound`) has no `ChatCommandFilter` seam (that seam
  exists only on the `app-ws-surface`, which Open does not mount). Wiring an
  optional `chatCommandFilter` hook into the chat-bridge (mirroring the existing
  `liveAgentTurn` / `scribeOnUserTurn` hooks) is the next scoped PR.

See "Trident — the foundational autonomous-build runtime" above for the boot
wiring.

**The Code-Gen Core gateway wrapper is RETIRED (2026-06-24).** `/code` is now
EXCLUSIVELY foundational Trident over the CC-subprocess substrate; there is no
direct-`@anthropic-ai/sdk` code path. The retired wrapper:
`gateway/cores/code-gen-factory.ts` (the `CodegenLlmCall` over a direct Messages
API call), `gateway/cores/build-production-codegen-wiring.ts` (the
credential→orchestrator→filter assembly), and `buildCodegenChatCommandFilter`
(the superseded legacy `/code` Core filter) are deleted. The Core's useful parts
— the multi-turn dispatch loop, Forge/Argus prompts, and output parsers — were
already folded into the foundational Trident runtime across PR-1..PR-5. The
`cores/free/code-gen/` Core ENGINE + its four `codegen_*` MCP tools + manifest /
install-lifecycle / sidecar remain a self-contained Tier-2 MCP surface (121
passing tests); their physical deletion is the one documented remaining cleanup,
left out because it is referenced by those MCP tools, the install
lifecycle/manifest, and the Managed graph composer. See
`docs/research/AS-BUILT-archive-2026-07.md`.

## Foundational Trident — state machine + tick + git-mode + the loop (`trident/`)

The `trident/` module (package `@neutronai/trident`) is the durable runtime
for the autonomous Forge → Argus → merge pipeline, ported from the legacy harness's
`/trident` skill. It is foundational runtime, not a Core. PR-2 landed the
state-machine skeleton; **PR-3 wired the real agentic loop** (below).

- **Persistence** — `code_trident_runs` (migration 0077): one row per
  pipeline. The SQLite translation of the legacy harness's per-run JSON state file. The
  in-flight sub-agent's id + status live ON the row (`subagent_run_id` /
  `subagent_status`) so the loop is restart-safe, instead of in the
  disconnected generic `runtime/subagent/` registry. `TridentRunStore`
  (`trident/store.ts`) is the CRUD wrapper, shaped like `ReminderStore`.
- **State machine** — `advanceTridentRun(run, deps)`
  (`trident/state-machine.ts`): the phase graph
  `forge-init → {argus | ralph-plan} → ralph-task → … → argus ⇄ forge-fix
  → done` with terminal `done | failed | stopped`, the Argus round cap
  (`max_rounds`, default 10) and the Ralph plan↔task round cap
  (`max_ralph_rounds`, default 20). The pure `computeTransition` owns the
  control flow; `deps.classify` reads the sub-agent outcome. PR-2 shipped
  `stubAdvanceDeps` (always "running"); PR-3 supersedes it with a real
  fire+harvest+merge `step` (below).
- **The loop** (PR-3) — `buildTridentOrchestrator` (`trident/orchestrator.ts`)
  composes the real loop into a tick `step`. The inner Forge→Argus→fix loop is
  ONE native CC Workflow (`trident/inner-workflow.mjs`), so the tick is
  fire-and-harvest, NOT spawn-and-poll-in-turn: (1) FIRE the current phase's
  inner workflow on a warm substrate (`trident/inner-loop.ts`) at the single
  `subagent_run_id === null`-guarded fire site — so a re-entrant tick never
  double-fires — then the launching turn settles immediately; (2) on a later
  tick, HARVEST the typed terminal result the workflow persisted to the DB
  (`parseInnerResult`, `trident/inner-loop.ts`) and apply it via `applyResult`,
  which constructs the terminal `done` / `failed` state directly
  (`trident/orchestrator.ts`); (3) merge on `done`, server-gating a
  merge-eligible `APPROVE` against the Argus checkpoint. (The legacy per-phase
  state machine `computeTransition` / `advanceTridentRun` (`trident/state-machine.ts`)
  is KEPT for its unit tests + one-commit revertibility but no longer drives the
  production inner-loop graph. The v1 blocking-dispatch `TridentSessionManager` /
  `trident/session.ts` bridge — which parsed the verdict from one held-open
  Forge/Argus turn — was deleted in #221.) The **oversized-diff guard** is a
  PROMPT-LEVEL ADVISORY, not a measured/partitioned check: `trident/inner-workflow.mjs`'s
  `ARGUS_RUBRIC` instructs the reviewer in natural language to "never read a
  >~3000-line diff in one shot" and to review the meaty commits one-by-one instead
  (the `3000` is a literal in that rubric string). The `ARGUS_DIFF_LINE_LIMIT`
  constant (`trident/prompts.ts`, also 3000) is SEPARATE — read only by
  `computeDiffLineCount` (`trident/orchestrator.ts`), a non-live helper kept for
  the legacy harness-parity tests / revertibility, not wired into the production loop.
  **Prompt source:** the live
  Forge/Argus execution contract is INLINED in `trident/inner-workflow.mjs` (the
  FORGE builder + `ARGUS_RUBRIC` + `FORGE_SCHEMA`) — the single live source, fired
  per run by `trident/inner-loop.ts`. `trident/prompts.ts`'s v1 render/parse loop
  was deleted with `session.ts` (only `ARGUS_DIFF_LINE_LIMIT` survives), and the
  `prompts/forge.md` / `prompts/argus.md` files are kept as NON-LIVE human
  reference (nothing loads them at runtime). The ONLY disk-loaded prompts are the
  atlas/sentinel SYSTEM personas (`prompts/{atlas,sentinel}.md` via
  `@neutronai/prompts` `loadPrompt`, `trident/agent-prompts.ts` → `dispatchAgent`).
  `trident/merge.ts` fills the
  `'pr'` (`gh pr merge --squash --match-head-commit <reviewed OID>` — #545: the
  merge is PINNED to the commit the reviewed diff was generated from — the
  building agent's reported `commitSha`, never a fresh head probe — carried in
  `inner_result.reviewedHead`, so a head that moved after the APPROVE fails
  LOUDLY instead of shipping unreviewed code) and
  `'local'` (`git merge --no-ff`) merge bodies — **no `git worktree remove`** (Open uses plain branches). Battle-
  tested the legacy harness fixes are mapped (see `trident/legacy-fixes.test.ts`): no
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
     (threaded via `session.nextTaskFor`), checks it off in
     `IMPLEMENTATION_PLAN.md`, commits code + tests. (Historical prompt:
     `renderRalphTaskPrompt`, since folded into `trident/inner-workflow.mjs`;
     the folded executor writes `IMPLEMENTATION_PLAN.md`, NOT the changelog —
     `docs/AS_BUILT.md` is the single consolidated as-built record that the
     planner READS (`inner-workflow.mjs:361`) and that unit PRs append to, not
     an executor-written artifact. Restoring an executor changelog-write would
     be a separate trident-loop change under self-surgery discipline.)
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
  `on_duplicate`. This mirrors the the legacy harness incident class where a registry-only
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

  - **`stuck` keys off JSONL turn-progress, not the in-memory clock** (ported
    from the legacy harness `stuck-turn-watchdog.ts`, incident 2026-04-21: a CC turn wedged
    3+ min while its `/health` port probe still answered OK — *port probes lie;
    the transcript JSONL is the source of truth for whether a turn advanced*).
    The same trap exists subtly here: `registry.update()` refreshes
    `last_event_at` on EVERY patch (defaults to `now()`), so a heartbeat / status
    touch / queue bookkeeping bumps it without real progress — masking a wedge.
    So the stuck check consults an injectable `turn_progress_at(rec)` probe wired
    in production to a tail-read of the child's transcript JSONL
    (`turn-progress.ts`: `parseTailForLastTurnProgress` over `realReadJsonlTail`,
    composed by `makeJsonlTurnProgressProbe`; "progress" = the latest `assistant`
    output or genuine `user`/`tool_result` activity, ignoring `system` /
    `queue-operation` noise). When the probe returns a timestamp it is
    AUTHORITATIVE — `last_event_at` is ignored for the staleness calc, the
    surfaced event records the overriding `turn_progress_at`, and `age_ms`
    reflects true JSONL staleness. When unwired or null (no transcript yet, an
    in-process `core` agent) the check falls back to `last_event_at` (legacy
    behaviour, preserved). A readable transcript whose 256 KB tail holds no real
    progress (the last `assistant`/`user`/`tool_result` record scrolled out,
    leaving only noise) reports `earliestEventMs` — a sound staleness floor — not
    null, so a long wedge can't evade detection by ageing its progress record out
    of the tail (Codex P2, 2026-06-25). The probe flows through `runLifecycleTick`
    untouched, so production wiring is a config change, not a watchdog change.
    **S4 wiring prerequisite:** `resolveTranscriptPath` needs the child's cwd to
    build `<projectsDir>/<cwd-dashed>/<child_session_id>.jsonl` (`dashifyCwd`,
    `session-validation.ts`); the in-process S3 registry carries
    `child_session_id` but not the cwd, so the SQLite-backed S4 registry must
    persist the child cwd before the gateway tick can wire the probe.

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

## Supervisor watchdog — what `stuck_agent` and `crashed_agent` actually mean (`watchdog/detectors.ts`)

The OS-process-level supervisor runs a tick of independent detectors over
`tools/process-registry.ts` and posts `⚠️ Supervisor alert: <kind>` to the owner.
Two of them read the live-process view; their definitions are NOT interchangeable
and getting them confused produced a user-visible P1.

- **`stuck_agent` = A DISPATCHED TURN STOPPED PROGRESSING.** Each `ProcessRecord`
  carries `busy_since: number | null` plus the owning `busy_turn_id`. The pool
  driver (`runtime/adapters/claude-code/persistent/pool.ts`) declares a turn
  outstanding via `LiveProcessHandle.markTurnStarted(turnId)` when it assigns
  `session.activeTurn`, and clears it with `markTurnSettled(turnId)` **in a
  `finally`**, so every unwind path — completion, early return, throw, cancel,
  timeout — settles. `ProcessRegistry.listStuck` returns only records with
  `busy_since !== null && busy_since < now - threshold`. **A record with
  `busy_since === null` is never stuck, however long it has been quiet.**

  This replaced a pure age filter over `last_activity_at` (2026-07-18). That
  field answers "when did this process last EMIT OUTPUT" — it is bumped only from
  the PTY `onData` handler in `spawn.ts`. But for a request/response REPL,
  **silence is the normal resting state**: a warm pooled session exists precisely
  to sit idle between turns so the next message skips a cold start. The detector
  therefore alerted on correct, healthy, by-design behaviour forever, and got
  worse with every topic in use (26 false alerts on a fixed half-hourly cadence
  against two verified-alive `cc-repl` PTYs on Ryan's install). Measuring from
  turn start also *gains* a signal the old filter missed: a turn that keeps
  emitting output but never completes (spinner / retry loop) now alerts.

  Both marker mutations are identity-guarded in the same style as
  `touchIfPid`/`unregisterIfPid` — `markTurnStarted` on `pid`, `markTurnSettled`
  on `pid` **and** `turn_id` — so a late call from a superseded turn or an old
  child cannot clear the marker of the turn (or the respawned successor) that
  replaced it, which would blind the detector to a real wedge.

  Leak prevention is the crux, because a latched `busy_since` would recreate the
  bug in mirror image (permanent alerts instead of permanent silence). Three
  independent covers: the `finally` at the dispatch site; the turn-id guard; and
  process death, where the child-exit handler in `spawn.ts` either `unregister`s
  the record or moves it to the crash queue via `markCrashed` — both of which
  drop the live record wholesale, so a dead child leaves nothing busy.

  **Scope — `stuck_agent` is a narrow backstop, not broad protection.** The
  per-turn driver watchdog in the pool catches most wedges an order of magnitude
  faster: `failFrozen` abandons a turn after 90 s of PTY silence
  (`TURN_INACTIVITY_MS`, `gateway/wiring/build-live-agent-turn.ts:95`; 180 s for
  cold/onboarding turns at `:107`) and enforces a 45-minute absolute ceiling
  (`TURN_ABSOLUTE_CEILING_MS`, `:117`). With `stuck_agent`'s 15-minute threshold
  (`detectors.ts`), the band it uniquely covers is a turn that keeps emitting
  output continuously — so the 90 s silence timer never trips — without settling,
  for 15 to 45 minutes. Real, but narrow. Do not treat a quiet `stuck_agent` as
  evidence that turns are healthy; the driver watchdog is the primary guard.

  **Not covered: the pre-turn phase.** `markTurnStarted` fires only once the
  driver assigns `session.activeTurn`, which is *after* `getOrSpawnSession` and
  `waitForReplIdle`. A turn wedged in spawn or the REPL handshake is therefore
  invisible to `stuck_agent` — bounded in practice by `waitForReplIdle`'s own
  `maxMs` cap in `spawn.ts` rather than by this detector.

- **`crashed_agent` = the child EXITED ABNORMALLY** (non-zero code, or an
  external signal we did not send). Unchanged by the above: the exit handler
  enqueues the crash into `pendingCrashes`, keyed `(name, pid)` independently of
  the live slot, and the detector reports each once and reaps it on commit. This
  is a genuinely useful signal and is fully intact.

## Agent dispatch family — named specialists + ad-hoc spawn (`agent-dispatch/`)

the legacy harness dispatches a small family of background specialist agents (and ad-hoc
ones) via `spawn-agent.sh` — each a separate Claude Code process that does a
task and reports back to the topic. Neutron's port collapsed that into the
single autonomous **Trident** build loop; `agent-dispatch/` restores the
**general dispatch surface** (parity scan §2.F / §5.3), built directly ON the
`runtime/subagent/` registry above (it does NOT fork a parallel system).

- **Kinds (`prompts.ts`).** Three owner/agent-facing kinds map onto the shared
  registry `AgentKind`: `research → atlas` (the lifted Atlas persona —
  research / analysis / ops / strategy / writing), `review → sentinel` (Sentinel
  — an independent quality check of NON-code work), and `adhoc → core` (a
  one-shot "just run this task" agent with a terse inline role). Forge/Argus are
  intentionally NOT dispatchable here — they are Trident build-loop agents with
  their own native parse contract.

- **`DispatchService` (`service.ts`).** The backend. `dispatch(req)` registers a
  `SubagentRecord` via `spawnSubagent` (so the SAME `MAX_CONCURRENT_SUBAGENTS`
  cap + double-spawn `spawn_key` guard apply), flips it to `running`, fires ONE
  substrate turn in the background, and on terminal drives the record
  `finished`/`crashed` + hands a structured announcement (`announce.ts`) to a
  `report` sink — the report-back. It shares the instance's registry +
  `ControlState` with the Trident loop, so the agent-aware **watchdog**
  supervises dispatched agents too; `watchdog-report.ts` adapts a reaped
  `AgentWatchdogEvent` (stuck / process_dead) onto the same `report` sink so a
  supervised failure surfaces instead of vanishing. `stop(run_id)` (and a
  watchdog reap) ACTUALLY cancels: the per-dispatch `AbortController` aborts, the
  cancellable turn runner (`substrate-turn.ts`) calls `handle.cancel()` on the
  live `SessionHandle`, and the registry goes `cancelled` — so the spawned
  subprocess is terminated, not just the record.

- **Cancellable turn (`substrate-turn.ts`).** The production `DispatchTurn`.
  Mirrors `buildSubstrateTridentDispatch` (fresh ephemeral CC-subprocess per
  turn rooted at `repo_path`; coalesce tokens; map completion/error/timeout) but
  honors an `AbortSignal` by cancelling the handle — the one capability the
  Trident closure lacks and a general dispatcher needs.

- **Persona rides the user turn, not `system`.** The runtime `AgentSpec` has no
  `system` field — the CC subprocess owns its own system prompt — so the
  production substrate (`buildSubstrateTridentDispatch`) drops `system`. To
  actually deliver a persona, the service folds `<role>\n\n---\n\nYour task:\n\n
  <task>` into the `user_message` (the same channel Forge/Argus ride).

- **Agent-native parity (hard invariant).** The `dispatch_agent` agent tool
  (`tool.ts`, capability `agent:dispatch_subagent`, `prompt-user` approval) and
  the `/dispatch` chat command (`command.ts` — `/dispatch research|review
  <task>`, ad-hoc fallthrough, `/dispatch stop [id]`) call the SAME
  `DispatchService.dispatch` backend. Neither owns dispatch logic.

- **Wiring (no feature flag).** `open/composer.ts` constructs the service over
  the same CC-subprocess `tridentDispatch` closure `/code` uses (NEVER a direct
  api.anthropic.com call) and threads `agent_dispatch: { service }` onto the
  `CompositionInput`; `gateway/composition/build-core-modules.ts` registers the
  `dispatch_agent` tool. Gated on the same credential availability as Trident
  (no credential → the surface is simply unregistered).

- **Deferred follow-ups (this is a first cut).** The `/dispatch` command's
  chat-bridge `ChatCommandFilter` thread (the parser/executor + their tests ship
  here); a live WS `agent_message` splice for the report-back (the first cut
  logs the announcement); a periodic watchdog tick registered over this registry
  in Open (the dispatch turn self-times-out as the primary bound; the watchdog is
  the backstop); and the rest of the legacy harness's persona set + cross-topic dispatch.

## Connect group-chat agent engagement mode — `connect/agent-engagement.ts` + the chat-bridge gate

A per-project setting, `agent_engagement_mode`, controls how the shared agent
engages in a Connect group/shared project (spec:
`docs/specs/connect-agent-engagement-mode-2026-06-26.md`). Two values, **no
feature flag** — the stored setting IS the behaviour:

- **`all_messages`** (DEFAULT) — every member post triggers an agent turn
  (single-person-chat-consistent; existing projects unchanged).
- **`tag_gated`** — the agent stays quiet until a member `@neutron`-mentions it.

**Storage.** `agent_engagement_mode TEXT NOT NULL DEFAULT 'all_messages'` on the
`projects` row (migration `0088_project_agent_engagement_mode.sql`).

**Pure core (`connect/agent-engagement.ts`, zero I/O).** The mode vocabulary +
`detectAgentMention` (case-insensitive, handle/alias aware, doc-quote guarded —
ignores `@neutron` inside inline-code / fenced blocks / blockquotes; rejects
`@neutrons` and `a@neutron.com`; multiple mentions collapse to one trigger),
`resolveEngagement` (the gate: mode + text + member access → engage?), and
`classifyTaggedIntent` (inline-answer vs delegate-to-subagent, by leading
imperative verb or explicit `/delegate [research|review]`).

**The routing gate — NOT currently wired (K11b0).** The engagement-mode gate
lived ONLY on the `/ws/chat` bridge's `handleProjectTopicInbound`
(`gateway/http/chat-bridge.ts`), which K11b0 excised — the bridge was fully dead
in production (onboarding + chat unified on `/ws/app/chat`). So `tag_gated`
enforcement is **currently unenforced on any live surface**: the app-ws seam
engages the agent on every project-topic turn regardless of mode. The pure core
above and the settings/MCP surfaces below remain (the mode still persists), but
nothing reads it at ingress. Re-implementing the gate on the app-ws seam
(`gateway/http/app-ws-surface.ts`) is tracked in the K11b0 D-note
(`docs/plans/2026-07-02-world-class-refactor-plan.md`, near D8). Intended design
for when it is revived: read the per-project mode (read-only + failure-safe →
`all_messages`); in `tag_gated` a non-mention post **persists to the shared
transcript WITHOUT an agent turn** (the transcript ALWAYS persists in both modes;
only the agent-turn TRIGGER is gated); a tagged TASK routes to a `delegateDispatch`
hook (a background subagent that reports back into the thread); a tagged question
is answered inline.

**Surfaces (agent-native parity).** Human admin: PATCH
`/api/app/projects/<id>/settings` whitelists `agent_engagement_mode`
(`gateway/http/app-projects-surface.ts` + `SqliteProjectSettingsStore`). Agent:
`get_engagement_mode` / `set_engagement_mode` MCP tools on the `agent-settings`
Core (`cores/free/agent-settings/`), sharing the same `projects`-table backend.

**Agent profile (name + personality) on Open.** `update_agent_name` /
`update_personality` route through an injected `AgentProfileBackend`. In a hosted deployment that backend opens the RW registry row; **Open has no
registry**, so historically `mount-open-cores.ts` threaded nothing and the Core
fell back to the `available:false` no-op — both tools returned
`SETTINGS_BACKEND_UNAVAILABLE_ERROR` on every Open box, breaking onboarding's
"update my name / switch personality later — just ask" promise. Open now threads
`buildOpenAgentProfileBackend` (`open/agent-profile-backend.ts`), which persists
to the only surface that feeds the live agent's identity in Open: the persona
files under `<owner_home>/persona/`. Name + personality land in a canonical
scalar store (`persona/agent-profile.json`, the `get()` source) **and** a
clearly-delimited managed block at the top of `persona/SOUL.md` — the exact file
`PersonaPromptLoader` (`gateway/wiring/persona-loader.ts`) reads every
agent turn and splices into the system prompt. The atomic write bumps SOUL.md's
mtime (so the loader's mtime-keyed cache re-reads on the next turn) and the
composer wires `onPersonaReload → personaLoader.invalidate('SOUL.md')` for
immediate pickup, so a later turn reflects the new name/persona. The managed
block is idempotently replaced and never clobbers onboarding-authored SOUL.md
content. (`NEUTRON_AGENT_NAME` is read once at boot but never composed into the
prompt, so it is NOT the persistence target.)

## PTY terminal-detection foundations (F1+F2+F3) — `runtime/adapters/claude-code/persistent/`

The persistent-REPL substrate drives the interactive `claude` TUI over a single
PTY read seam (a rolling ring fed by `onData`) and one write seam
(`child.write`). the legacy harness's tmux era accreted ~21 detectors that watched the pane
for a state signature and reacted with a keystroke; porting those to Neutron
needs three reusable primitives first. This PR ships the substrate (detectors
themselves land in follow-on P0/P1 PRs). See
`docs/research/legacy-terminal-detection-keystroke-port-2026-06-25.md`.

- **F1 — public ring-read accessor (`pty-ring.ts`).** `PtyRing` replaces the
  old debug-gated 16 KB closure (`debugRing()`, `NEUTRON_REPL_DEBUG`-only) with
  a widened 64 KB rolling buffer + `getRecentOutput({ bottomN?, normalize? })`:
  line-addressable (bottom-N newline-delimited lines, à la `capture-pane -S`) and
  optionally `normalizePtyText`-collapsed so Ink per-word-cursor ANSI doesn't
  break contiguous-signature matching. Exposed on `ReplSession.getRecentOutput`.
  The 64 KB widening (from 16 KB) is so bottom-N guards can see content rendered
  *below* the footer (the 2026-06-16 status-panel miss).
- **F2 — structured keystroke API (`keystrokes.ts` + `PtyChild.writeKey`/
  `writeKeys`).** Named keys (`enter`/`escape`/`ctrl-c`/`tab`/arrows/digit) encode
  the exact terminal bytes a real keypress emits (Enter=`\r`, Esc=`0x1b`,
  Ctrl-C=`0x03`, Up=`ESC[A`, Down=`ESC[B`, digit=literal char). Multi-key
  sequences (`['down','enter']`, `['3','enter']`) navigate Ink arrow-pickers /
  numbered menus that raw `write('\r')` cannot. The encoding is pure; the Bun
  backend wires the methods, and the substrate degrades to `write(encodeKeys(…))`
  for fakes that predate the optional extension (`sendKeys`).
- **F3 — output-scan tick (`output-scan.ts`).** `OutputScanner` runs registered
  `{ id, present, keys }` detectors against the ring from the existing `onData`
  hook (GENERALIZED — not a competing scan loop). Four the legacy harness invariants are baked
  in, each encoding a paid-for incident: **edge-triggered latched** firing
  (rising edge only — a pure time-dedupe re-fired hourly on a stale banner);
  **doc-quote guards** (`stripDocQuotes` rejects fenced / diff / bullet /
  inline-backtick matches so quoted menu text can't false-fire); **bottom-N
  positional guards** (default bottom-24); and **per-detector debounce stamped
  BEFORE the await** (the latch + last-fire are committed inside `scan()`, so a
  transport-failed keystroke write can never retry and double-send onto an
  approval prompt). The dev-channel first-run disclaimer auto-dismiss is now the
  first registered detector; P0 wedge-prompt recovery (below) + P1 auto-approve /
  compact-resume / rate-limit-stop + the P2 rate-limit/overload **banner** alert
  (notify-only, row #10) all register the same way.

## Wedged-interactive-prompt detect + recover (P0) — `interactive-prompt-deadlock-detector.ts`

The flagship terminal detector (master-table row #1). When `claude` renders an
`AskUserQuestion` / arrow-menu **mid-turn**, the REPL deadlocks — the chat
surface has no keystroke path to the TUI, so the menu sits forever and the only
thing that notices is the 5-minute inactivity watchdog, which **kills** the
agent. Per Ryan's 2026-06-25 SPEC Decisions Log the policy is detect+**recover**,
not kill.

- **Detect (`isWedgedInteractivePrompt`, all gates ported verbatim).** Over the
  bottom-54 ring window (so the footer-in-bottom-24 *and* a cursor up to 30 lines
  above both fit): **(0)** reject the normal live/working chrome (`⏵⏵` / `bypass
  permissions` / `esc to interrupt` / `? for shortcuts`) — that's not a wedged
  menu; **(a)** a footer carrying all of `enter to select` + `to navigate` +
  `esc to cancel` within the bottom-24; **(b)** a live cursor `/^❯\s*\d+\./` in
  the ~30 lines above the footer; **(c)** a `seenLastTick` **2-tick stability
  gate** (`createWedgedPromptDetector` — a half-rendered menu present for a single
  tick never fires). The F3 doc-quote guard + the `^❯` line anchor reject a
  fenced / `>`-quoted / backtick-wrapped menu (a docs example can't false-fire).
- **Recover (`runWedgedRecovery`, bounded ladder).** `writeKey('escape')` →
  wait → re-read the ring → verify cleared; if not, `escape` again → verify;
  if not, `ctrl-c` → verify. A **failed re-capture (`null`) counts as
  NOT-cleared**, so it keeps escalating rather than assuming success. It **NEVER
  auto-picks** — only escape/ctrl-c ever leave the keyboard, never a digit or
  Enter. On a persistent block after the full ladder it surfaces the captured
  question to the active turn's chat channel (the dev-channel surface) and fires
  **one** operator alert (`postWedgeAlert`).
- **Drive sites.** `runOutputScan` is shared by the PTY `onData` callback (fires
  while the menu is still emitting render output) and the per-turn liveness
  keepalive (the wedge can only happen mid-turn — exactly when that interval
  runs — and a STATIC wedge emits no further output, so the keepalive cadence is
  what satisfies the 2-tick stability gate and detects it). `session.wedge
  Recovering` guards the async ladder window against a concurrent relaunch.
- **Lessons carried (comments).** AskUserQuestion deadlocks with no keystroke
  path from chat (2026-06-06 Neutron incident); bottom-N widened 8→24 after the
  2026-06-16 status-panel-below-footer miss; the `^❯` anchor rejects
  quoted / diff menu lines; a failed re-capture is NOT a clear.
- **P1 — auto-approve tool-use prompt (port row #2).** A second detector
  (`id: 'tool-use-approve'`) registered on every session's `OutputScanner`
  clears CC's tool-use permission prompt. It fires only when **BOTH** cues are
  present in the normalized bottom-N view — the question
  (`/doyouwantto(makethisedit|proceed|runthiscommand|create)/i`) **AND** the
  `❯ 1. Yes` selector (`/❯1\.yes/i`) — because a single cue false-fires on
  lingering scrollback (a prior approval's selector with no live question). On
  the rising edge it sends `1`+`enter`. A 5s `debounceMs` floor is set, and the
  framework stamps the latch + last-fire BEFORE returning the fired detection,
  so a transport-failed write can NOT retry and DOUBLE-Enter onto the approval.
  These prompts render even under `--dangerously-skip-permissions` for
  key-to-kingdom paths (`.git/hooks/*`, writes outside the project root), so the
  substrate must clear them itself.
- **P1 — /rate-limit-options org-cap auto-stop (port row #4).** A third detector
  (`id: 'rate-limit-options-stop'`) registered on every session's
  `OutputScanner` auto-stops CC's `/rate-limit-options` org-monthly-cap picker
  (Ryan 2026-05-23: "Just select stop and wait for limit to reset"). It fires
  only when **BOTH** cues are present in the normalized **bottom-30** view — the
  slash command (`/\/rate-limit-options/i`) **AND** option 3's verbatim text
  (`/stopandwaitforlimittoreset/i`) — and sends `3`+`enter` on the rising edge
  (`'3'` is position-independent). The **bottom-30 positional guard is
  load-bearing**: pressing `3` STOPS CC, so no new output scrolls the picker away
  and the stale text would otherwise re-fire `select-stop` into dead input for
  days (the legacy harness PR #132 r1) — the bottom-N window lets idle whitespace push the
  picker past the threshold so the detector correctly stops. A 60s `debounceMs`
  floor + the framework's before-await latch stamp make `3`+enter fire-once. The
  F3 doc-quote guard keeps a quoted/backtick mention of the command from firing.
  the legacy harness's viewport-pre-check-gates-recapture lesson (Argus #132 r3) is obviated:
  Neutron's in-memory ring read IS the cheap viewport check — no scrollback
  recapture to gate.
- **P1 — compact-resume picker (port row #3).** A third detector
  (`id: 'compact-resume-picker'`) registered on every session's `OutputScanner`
  clears CC's summary-vs-full picker shown when resuming an auto-compacted
  session. It fires on an **EXACT-STRING** match of either literal label in the
  normalized bottom-N view — `Resume from summary (recommended)`
  (`/resumefromsummary\(recommended\)/i`) **OR** `Resume full session as-is`
  (`/resumefullsessionas-is/i`) — and **nothing broader**: a prior broad
  `summary+full+numbered` fallback fired on normal conversation and injected
  `2<Enter>` into live panes. The picker is **arrow-driven, not number-key**, so
  on the rising edge it sends `down`+`enter` (never a digit). A 5s `debounceMs`
  floor is set and the latch is stamped before return (fire-once, same as
  `tool-use-approve`); the append-only-ring back-to-back limitation and the P0
  wedge-recovery backstop apply identically.
- **P2 — resume-session-failure picker safety net (port row #7) —
  `resume-picker-detector.ts` + `session-disk-recovery.ts`.** When
  `claude --resume <stale-id>` is started against a session id that no longer
  exists, CC drops into an interactive **"Resume Session"** picker that blocks the
  REPL. The hard-won the legacy harness lesson is **ESCAPE-THEN-RECOVER, never blind-answer**: a
  stale cached `session_id` must NOT silently spawn a fresh, empty-context session
  without a disk-recovery attempt + a user-visible "session lost" notice — blind-
  picking an option throws away the user's context silently. A detector
  (`id: 'resume-session-picker'`, no `keys`) registered on every session's
  `OutputScanner` fires on the **distinctive `Resume Session` title AND the
  `Esc to clear` footer cue** in the normalized bottom-N view. Requiring the title
  + the `Esc to clear` footer (not a bare OR over the loose SPEC phrases) is what
  keeps it disjoint from the AskUserQuestion menu (whose footer is `esc to cancel`,
  handled by the P0 detector #1) — the two never collide. The F3 doc-quote guard
  keeps a quoted/fenced/backtick mention of "Resume Session" from firing, and the
  framework edge-latch fires it once per absent→present transition. On the rising
  edge the substrate runs `runResumePickerRecovery` (`dispatchResumePickerRecovery`,
  guarded by `session.resumePickerRecovering` against a concurrent ladder): it
  sends a **single `Escape`** (never a digit / Enter), then calls
  `findLatestResumableSession(cwd, resolveTranscriptProjectsDir(options), { excludeSessionId })`
  — the Neutron analog of the legacy harness's `findLatestSessionForTopic` — which scans
  `<projectsDir>/<dashifyCwd(cwd)>/*.jsonl` for the most-recently-modified
  transcript with ≥1 non-empty line (**JSONL-is-truth, invariant §5**; the stale id
  that just failed is excluded so it can't "recover" itself). The transcript root is
  resolved via the **shared** `resolveTranscriptProjectsDir` (explicit
  `projectsDir` → `CLAUDE_CONFIG_DIR/projects` → `~/.claude/projects`) so the scan
  finds an isolated-config session's JSONL exactly where the API-5xx watcher looks.
  On a hit the recovery **moves the live REPL onto the recovered session**: it
  records the id on `session.pendingResumeSessionId` and **poisons** the warm child
  (which just escaped the picker and is contextless). `getOrSpawnSession` does NOT
  re-read `resolveResumeDirective` while an unpoisoned warm child is alive, so the
  poison is what makes the **next** turn evict + respawn, and
  `pendingResumeSessionId` is carried as the `forceResume` directive so that respawn
  `--resume`s the recovered transcript (bypassing the stale-id registry — and the
  race against this spawn's own registry write). The current in-flight turn finishes
  on the fresh child; the notice tells the user the recovered context is **active
  from their next message**. A **miss** surfaces a "session lost — starting fresh"
  notice + one operator alert AND fires `onNoRecovery` → `session.forceFreshRespawn`
  + poison, so the next turn respawns with resume FORCED OFF (the `evictedForceFresh`
  branch) and rewrites the registry `has_session: false` — otherwise the stale
  `--resume` id `spawnSession` persisted would reopen the picker on a later
  crash/watchdog respawn (Codex P2). Spawn-time notices route through `ReplSession.pushNotice`
  (buffered until the first live turn, since the picker fires before `start()`
  assigns `activeTurn`) and are drained by `flushPendingNotices`. This closes
  master-table **row #7**. It is **largely obviated** by Neutron's
  JSONL-first resume (`session-respawn.ts` / `session-validation.ts` /
  `session-capture.ts`), which avoids the picker in the normal path — this is a
  pure safety net for if it ever appears. **Out of scope (by design):** changing
  the JSONL-first resume path; auto-picking any picker option.

## Per-turn API-5xx dead-turn notifier (JSONL watcher, port row #11) — `api5xx-dead-turn-watcher.ts`

A mid-turn API 5xx — `Overloaded` / `internal_server_error` / `rate_limit_error`
— aborts the agent's turn BEFORE it ever calls `reply()`. The substrate's turn
`completion` never resolves, so the user sees **nothing**: the turn dies silently
(Ryan 2026-06-16). None of the other detectors catch this — the PTY-ring
detectors (above) key off live TUI signatures, the stuck-turn watchdog (below)
keys off an *unanswered real-user turn* going stale, and the dead-repl-detector keys
off process liveness / HTTP. A turn the model *started* but a 5xx killed before
any reply is a distinct gap. This closes master-table **row #11**.

Unlike the PTY-ring detectors this is a **JSONL watcher**, not a ring scan
(cross-cutting invariant §5 — disk is the source of truth; the typed JSONL
records mean we never have to disambiguate a real CLI error line from prose that
quotes "API Error: 500"). It does NOT touch the `OutputScanner` / ring.

- **Watch.** `startApi5xxDeadTurnWatcher` `fs.watch`es the turn's transcript JSONL
  (`<projectsDir>/<dashifyCwd(cwd)>/<sessionId>.jsonl`) — actually the parent
  directory, so it survives the file not existing yet / a resume re-creating it.
  Each change pumps the bytes appended since the last read into an
  `Api5xxDeadTurnCore`.
- **Match (allowlist + pattern, invariant §3).** The 5xx regex
  (`/Overloaded|overloaded_error|rate_limit_error|internal_server_error/`,
  carried verbatim) is tested ONLY against `result` / `system` / `error` records.
  `type:"user"` and `tool_result` records are ignored entirely — tool output
  legitimately echoes the word "overloaded" and must never trip the detector.
- **Reassemble (invariant §4).** `Api5xxDeadTurnCore.feed` buffers a trailing
  partial line until its newline lands, so a record split across two `fs.watch`
  callbacks is reassembled, never misparsed.
- **Edge-latch (invariant §1).** A matching error record fires ONCE on the rising
  edge and latches; a further 5xx record while latched does NOT re-fire (no
  hourly-re-fire-on-stale-line bug); a later *healthy* considered-record clears
  the latch so a fresh error can fire again. The latch is stamped inside `feed`
  BEFORE the notify side-effect runs, so the notify is fire-once even if it throws.
- **Surface.** On the rising edge the watcher calls the injected `onDeadTurnNotice`
  sink (a runtime→gateway DI seam mirroring `onRecoveredReply` / `postWedgeAlert`)
  with a "resend your last message" retry affordance. **ON by default, no feature
  flag**: when the gateway doesn't inject a sink it falls back to a structured
  stderr notice. The watcher is started per session right after the child spawns
  (sessionId + cwd are known → the path resolves immediately) and stopped on child
  death. **Out of scope this pass:** auto-resend of the stored message (notify +
  affordance only).

## Rate-limit / overload banner alert (notify-only, port row #10) — `rate-limit-banner.ts`

The **passive** rate-limit surface (master-table row #10). When CC prints a
rate-limit / overload BANNER — a transient Anthropic-side 429/529/overload/502, or
the subscription window cap — nothing previously told the user; the picker
auto-stop (row #4) only handles the *interactive* `/rate-limit-options` org-cap
menu, not the passive banner. This closes that gap with an **edge-triggered,
NOTIFY-ONLY** alert. It is the passive sibling of row #4: row #4 PRESSES `3`; this
one never sends a keystroke and never auto-retries — it only informs.

- **Two severities, two detectors** (`createRateLimitBannerDetector` ×
  `temporary` | `usage-cap`), registered on every session's `OutputScanner`.
  `temporary` = Anthropic-side transient (`Server is temporarily limiting requests`
  + `API Error`, `Overloaded` + `API Error`, `502 Bad Gateway` +
  `api.anthropic.com`) — CC retries on its own; `usage-cap` = the subscription
  window cap (`Claude usage limit reached`, `5-hour rate limit reached`, `usage
  limit. Please try again at`) — no auto-recovery. Each cue set requires ALL of its
  substrings on one line, so bare "Rate limited"/"Overloaded" log noise can't fire.
- **Edge-latch per `threadId::severity` (invariant §1) — the load-bearing fix.** A
  pure *time*-dedupe re-fired the alert HOURLY FOREVER on a stale banner sitting in
  an idle pane. The framework's per-detector edge-latch IS that latch, expressed
  structurally: one detector per severity → the latch key is `(session.scanner ≡
  threadId) × (detector id ≡ severity)`. Fires on absent→present, clears ONLY on
  present→absent.
- **Guards (the exact three the spec enumerates).** doc-quote (the F3
  `stripDocQuotes` removes fenced/diff/bullet/blockquote lines + blanks
  inline-backtick spans before `present` runs); **bottom-30** positional window
  (`RATE_LIMIT_BANNER_BOTTOM_N` — a banner above it is stale scrollback CC retried
  past); and **not-at-idle-prompt** — when the bottom-most live line is an idle
  prompt the banner has by definition cleared. The idle-prompt walk **SKIPS chrome**
  — bypass-permissions banner / "new task?" hint / `ctrl+…` affordances /
  box-drawing borders — or a retired 429 above the chrome false-fires (book topic,
  4 hourly alerts on a long-retired 429, 2026-05-15).
- **Surface.** NOTIFY-ONLY — the `DetectorSpec` carries NO `keys`. On the rising
  edge `runOutputScan` routes the fire to `dispatchRateLimitBannerNotice`, which
  re-derives the verbatim banner line and surfaces it three ways (mirroring the
  size-alert surface): the active turn's channel if one is in flight, an operator
  stderr log (always), and the injected `onRateLimitBanner` DI seam (a
  runtime→gateway seam — the gateway wires the richer chat-surface alert).
  **ON by default, no feature flag.** **Out of scope:** any keystroke / auto-action
  (row #4 owns that) and auto-retry.

## Post-spawn liveness assertion — channel-MCP-bound gate (port row #6) — `post-spawn-assertion.ts`

`assertReplAlive` gates every fresh spawn before the first inject, in ordered
stages, the first to fail returning its specific reason: **(1)** child alive
(`!hasExited`) → `dead-child`; **(2)** dev-channel transport attached
(`/channel-ready`) → `no-channel-ready`; **(3)** dev-channel HTTP `/health`
responds → `no-http-health`; **(4)** dev-channel MCP handshake complete
(`/channel-bound`) → `channel-wedged`. Stage 4 is the **channel-MCP-unwired
wedge** guard: a spawn can come up `/health`-200 (LOOKS alive) yet claude never
wired the channel MCP, so every `reply()` fails and the turn never delivers.

### The 2026-06-26 P0 correction — the wedge was a false-positive

The original Stage 4 detected the wedge by scanning the PTY ring for **"no MCP
server configured with that name"** (`channel-unwired-detector.ts`, ported from
the legacy harness's `isChannelMcpUnwired`). Reproduced **live under the real Bun PTY harness**
(`Bun.spawn({terminal})` + the real `build-repl-argv` argv + the real
`dev-channel.ts`, instrumented at the stdio JSON-RPC boundary), that string is a
**benign warning claude 2.1.186 ALWAYS prints** for an `--mcp-config`-provided
development-channel server — the dev-channel completed a clean
`initialize`/`tools/list` handshake AND a real injected turn round-tripped through
the `reply` tool, while the TUI still showed the warning. So the detector was a
**false-positive that fast-failed EVERY interactive spawn** → bounded-respawn cap
→ every LLM turn died (then mislabeled downstream as a credential cooldown). A
plain `claude -p` repro never showed the line (print mode skips the channel-status
TUI render), so every manual repro "passed" and #79's blocking-handshake theory
chased a non-bug. The string detector + its test were **removed**.

- **Real bind signal (`/channel-bound`).** `dev-channel.ts` sets
  `mcp.oninitialized` (the SDK fires it on claude's `initialized` notification) →
  POSTs `/channel-bound` to the reply-sink. That is the only reliable proof claude
  wired the `claude/channel` capability + `reply` tool. The sink records it on the
  `ReplSession` (`channelBound`).
- **Stage 4 gate.** After `/health` is up, poll `isChannelBound()` within
  `channelBoundBudgetMs` (default 15s — generous because the interactive
  dev-channel disclaimer can defer the handshake until the F3 output scanner
  dismisses it). Never arrives → `channel-wedged`. A genuine no-bind wedge (claude
  never handshakes → no `/channel-bound`) is still caught; the benign TUI warning
  no longer fails a working channel. Stage 4 is skipped when no bind probe is wired.
- **`MCP_CONNECTION_NONBLOCKING=false`** (kept from #79) forces claude onto its
  blocking MCP-load path so the single dev-channel server connects + handshakes
  before the first input — a belt-and-suspenders that makes `/channel-bound` land
  promptly, **NOT** the wedge fix.
- **Bounded respawn (`channel-unbound-respawn.ts`, invariant §6).** Unchanged: a
  `channel-wedged` assertion throws `ChannelWedgedSpawnError`; the spawn path
  retries up to **`MAX_FLEET_RESPAWNS = 2`**, then fires **exactly one** operator
  alert and gives up — no infinite loop. A spawn/channel failure that still
  surfaces to the LLM caller is classified as a SUBSTRATE failure in
  `build-llm-call-substrate.ts` (skips the pool cooldown) so it can never be
  relabeled "all Anthropic credentials are in cooldown".
- **Per-turn timeout is NOT a credential fault (P0a, 2026-06-26).** A
  `persistent-repl: turn timeout` (a turn that fails to settle inside
  `DEFAULT_TURN_TIMEOUT_MS=180_000`) is surfaced RETRYABLE with no HTTP status.
  `build-llm-call-substrate.ts`'s `detectTurnTimeout()` fast-path classifies it
  BEFORE the cooldown map (alongside binary-not-found / channel-wedged), skips
  `reportFailure`, and re-emits it unchanged — so a slow turn is a recoverable
  single-turn retry (the substrate poisons + respawns the warm session) instead
  of parking the credential and cascading into "all credentials in cooldown".
- **Regression guard.** `dev-channel-pty-bind.e2e.test.ts` spawns claude under a
  real `Bun.spawn({terminal})` PTY and asserts `/channel-bound` fires + a turn
  round-trips DESPITE the benign warning (opt-in `NEUTRON_PTY_E2E=1`, skipped in
  CI — needs a real claude binary + credentials).

## Disk-JSONL recovery + restart-rate crash-loop guard (#20) — `jsonl-resumability.ts` + `restart-rate.ts`

The cross-restart recovery substrate (master-table row #20). It encodes one
hard-won lesson: **disk JSONL is the source of truth; the in-memory
registry/timer is just an index.** Incident (Nova/the legacy harness spurious-idle 2026-05-21):
the gateway restarted, scheduled a `setTimeout`-based zombie respawn, then
restarted AGAIN 118s later — wiping the in-memory timer — so the topic vanished
silently even though its JSONL was fully intact. Recovery must reconstruct from
disk on boot, never rely on a surviving timer.

Three layers, two new this build, all wired through `startReplWatchdog`'s boot
path:

- **Pending-respawns queue + boot-drain (pre-existing).** `pending-respawns-
  queue.ts` snapshots each deferred respawn to `<home>/.neutron/.pending-
  respawns.json` BEFORE the drain `setTimeout`s fire; `drainPendingRespawns`
  reads that file at boot (and on every watchdog tick) and replays the dropped
  inbound via the dev-channel `/message` sink — no surviving timer required.
- **Disk-JSONL resumability classifier (NEW, `jsonl-resumability.ts`).** When the
  boot-drain meets a pending entry whose owning substrate has not re-registered
  yet (the cross-restart-before-first-turn case), it no longer just skips
  blindly: it reads the topic's transcript JSONL and classifies it. The pure
  `classifyResumable` reasons over disk metadata — `no-jsonl` / `empty` /
  `no-real-turn` (a true ghost → not resumable) vs `live` (a real conversational
  turn on disk → RESUMABLE, retained for recovery) vs opt-in `stale`. A real
  turn is a user/assistant `message` line (summary/system meta lines don't
  count). This makes "scheduled-but-lost across a restart, recovered from disk,
  NOT silently dropped" an observable property of the drain result
  (`resumable: true`). Honours invariant #5 (disk is truth) — with no `maxAgeMs`
  cutoff, age alone never disqualifies an intact transcript.
- **Restart-rate crash-loop guard (NEW, `restart-rate.ts`).** Each watchdog boot
  appends a restart marker (epoch ms) to `<home>/.neutron/.restart-markers.json`.
  Two markers <5min apart (`CRASH_LOOP_WINDOW_MS`) is the crash-loop signature
  (the 118s double-restart). The warning is **edge-triggered + latched**
  (invariant #1): it fires ONCE on the absent→present edge via `postAlert` (or
  stderr) — a sustained loop does not re-warn every boot — and the latch clears
  when a normally-spaced restart returns, re-arming for the next loop. Auto-
  restart makes a crash loop worse (it wipes in-flight timers), so the guard
  surfaces it to an operator instead of absorbing it.

Both new modules are pure-by-default (the classification + the edge-latch
transition are pure functions over already-read state; the disk read/write is a
thin fs-injectable wrapper) and best-effort at the boot seam — a classification
or marker-write failure can never block watchdog startup. Per-thread respawn
caps (`RESPAWN_CAP_MAX` 3/hr → `capped_at` hard-stop, invariant #6) are
unchanged and still apply; this recovery path never bypasses them.
- **P2 — session-size watchdog + compact affordance (port row #13).**
  `session-size-watchdog.ts` watches a **warm/persistent** session's transcript
  growth, the one class the F3 output-scan detectors don't cover (it keys off the
  JSONL on disk, not the PTY ring). Started right after the post-spawn assertion
  passes (`session.sizeWatchdog`) and stopped on child exit / teardown, it
  measures the **post-compact** JSONL size every 5 min and, on a rising edge into
  the warn (≥5 MB) / critical (≥10 MB) band, surfaces a Reset/Compact affordance
  via `surfaceSizeAlert` (active turn channel + operator log + the injected
  `onSizeAlert` hook). It exists because `reset_context_per_turn` (`/clear`) only
  caps growth on the import path — a conversational REPL had **no** size monitor
  and could grow until `claude --resume` is refused and the session falls into an
  infinite restart loop (the legacy harness 2026-04-16: the "tax topic" hit 11.8 MB).
  - **THE LOAD-BEARING LESSON — measure POST-COMPACT size, never raw
    `stat.size`.** The size that matters is the bytes **after the last record
    carrying `"isCompactSummary":true"`** (`measurePostCompactBytes`, a byte-
    accurate `Buffer.lastIndexOf` scan — the marker can sit far past the 256 KB
    tail the stuck-turn reader uses, so that tail reader is unsuitable here). When
    a user runs `/compact` the file does **not** shrink on disk — CC appends a
    summary record and keeps writing, so raw bytes stay huge. A raw-size watchdog
    would warn, the user would Compact, raw size would barely move, and the warn
    would **re-fire forever** ("Compact does nothing"). The post-compact region is
    the only signal that actually drops when a compaction helps.
  - **PreCompact lock.** A compaction in flight momentarily looks huge (the
    pre-summary turn is still appended before the marker lands). The watchdog
    holds a mid-compact lock from the moment **it** actuates a compaction until
    the post-compact size drops back below the warn band (the summary landed), and
    **skips all alerting** while held — no spurious per-compaction warn. The lock
    ALSO auto-clears past a max-lock window (`compactLockMaxMs`, 2 min) so it can
    never permanently silence the watchdog: a genuinely large conversation can
    stay ≥5 MB even after a successful compaction (and an actuated `/compact` may
    fail), so the timeout is a completion signal independent of the size dropping
    — a still-large session re-surfaces the affordance instead of going dark
    (Codex review, 2026-06-25).
  - **Tiered edge-latch** (cross-cutting invariant §1): warn fires once on
    entering the warn band, critical once on entering critical (incl. a
    warn→critical escalation); the latch clears on shrink so re-entry re-fires.
    Never time-dedupe.
  - **Compact action** = `writeKey('escape')` THEN `child.write('/compact\r')`,
    fire-once — the lock + debounce are stamped **before** the writes (invariant
    §4) so a transport failure can't double-`/compact`. It is reachable both as a
    **surfaced affordance** any gateway/user presses (`requestSessionCompact(
    sessionKey)`) AND automatically via the idle-gated POLICY below.
  - **Idle-gated auto-compaction POLICY (gap #4 — the actual compaction trigger).**
    The watchdog SURFACES the alert, but on Open's **WS-native web chat** there is
    no inline keyboard and **nothing calls `requestSessionCompact`** — so the
    affordance alone is a dead end and a long-lived single-owner session would just
    keep growing until `--resume` wedges (the 2026-04-16 11.8 MB incident). The
    substrate therefore wires an `isIdle` dep so the watchdog **actuates the same
    `escape`+`/compact` automatically when the post-compact size reaches the
    **critical** band AND the session is at rest** (`session.activeTurn ===
    undefined` and the PTY quiet ≥ `SESSION_COMPACT_IDLE_QUIESCE_MS`, 30 s — never
    mid-turn). It is **edge-latched + debounced**: it fires **once per critical
    episode** (an outer `autoCompactLatched` flag), de-latches only when the
    post-compact size drops back below critical (a re-climb may fire again), and
    is **kept latched** when the mid-compact lock clears via timeout on a
    still-large/failed compaction (so it can't re-fire `/compact` in a loop). A
    session that crossed critical while **busy** is left un-latched so the next
    idle tick still actuates (no missed one-shot). This is **not a feature flag** —
    the policy is active wherever a live PTY child is wired (the default); a
    gateway that DOES wire a pressable Reset/Compact button (the legacy harness's Telegram
    inline keyboard) simply omits `isIdle` and stays surface-only. the legacy harness's own
    `session-size-watchdog.ts` is likewise warn-only at the engine level — its
    "policy" is the clickable buttons it posts; Open closes the same loop with the
    idle auto-actuation because it has no button surface.

## cwd-drift watchdog (P3, port row #12) — `cwd-drift-watchdog.ts`

A **NON-substrate** watchdog over the PTY child **pid** — NOT an output-scan ring
detector, and it never touches the `OutputScanner` register-block. A PTY child's
live working directory can drift off the session's canonical cwd (a Bash `cd`
into a worktree that later gets merged/removed leaves the child pinned to a dead
dir, while the session's canonical project dir is still valid). The wedge
watchdog keys off liveness + `/health` and is blind to this — the child is alive
and answering, just rooted in the wrong place.

- **Detect (ASK THE OS DIRECTLY, async + batched).** A separate tick (default
  60s, its own in-flight gate — lsof is heavier than the wedge tick's `/health`
  fetch) asks the OS for each LIVE pooled child's cwd via **async**
  `lsof -p <pid> -d cwd -Fn`, batched through `mapWithConcurrency` at **cap ~5**
  concurrent. This is the deliberate replacement for the sync `lsof×20` that
  stalled the event loop ≤40s (2026-04-23). The live cwd is compared to the
  session's canonical `record.cwd` via the pure `isCwdDrifted` — **trailing-slash
  normalized** with **descendant tolerance** (a `cd` into a project subdirectory
  is NOT drift; only a cwd outside the canonical subtree counts).
- **Recover (respawn pinned to canonical).** On drift, `respawnReplSession` fires
  with the new `cwd-drift-watchdog` trigger. The respawn already spawns from
  `record.cwd`, so the child is **automatically pinned back to canonical** (the
  `cd '<cwd>' && claude --resume` analog) — context preserved via the
  resume-is-always-resume invariant.
- **Existence guard — missing canonical → NEVER respawn.** Checked BEFORE the
  drift comparison: a respawn spawns from `record.cwd`, so a missing canonical can
  never be respawned (into nothing). This also catches the child still rooted IN a
  canonical dir that has since been **deleted** — lsof reports `<path> (deleted)`,
  which `normalizeCwd` strips, so it would otherwise read as "not drifted" and slip
  past the guard. Either way the watchdog refuses to respawn and fires an
  **edge-latched** operator alert (`buildCwdDriftMissingCanonicalAlert`) — once on
  the rising edge, never re-firing every tick on a persistently-missing canonical.
- **Per-session 1h respawn throttle.** A `cwdDriftRespawnState` map (separate
  clock from the wedge cooldown) gates a re-respawn within an hour, so a
  persistently-drifting child can't churn. The throttle is stamped BEFORE the
  respawn await (fire-once per detection — a failed respawn still holds the
  window).
- **Pure + injectable.** The cores (`normalizeCwd` / `isCwdDrifted` /
  `decideCwdDriftAction`) + `runCwdDriftTick` are hermetically unit-tested; the
  live wiring (`runCwdDriftWatchdogTick`, scoped to its instance registry like
  the wedge tick) is exercised end-to-end against the real substrate
  (`repl-supervision.test.ts`).

This closes master-table **port row #12** (previously the last MISSING P3 watchdog
in `docs/research/legacy-terminal-detection-keystroke-port-2026-06-25.md`).

## Model-update watchdog + graceful upgrade (P3, port row #16) — `model-update-watchdog.ts`

Auto-detects when Anthropic ships a newer top-tier Claude model and gracefully
moves every warm session onto it — so the box never drifts on a stale model for
days (the legacy harness 2026-04-16: Opus 4.7 shipped overnight, the gateway sat on 4.6 for
hours because nothing noticed). A **NON-substrate**, instance-wide watchdog
(NOT an `OutputScanner` ring detector): a periodic probe + an idle-gated respawn
loop, started once per instance alongside the wedge watchdog
(`createClaudeCodeSubstrateAuto`).

- **Probe (every 6h, NO `--fallback-model` — the load-bearing lesson).** A
  15-min cadence tick is gated by `shouldRunModelUpdateCheck` (a persisted 6h
  cache) so the actual probe runs ~4×/day. The probe runs `claude -p --model opus
  "Reply ONLY with: MODEL_ID=<id>"` **asynchronously** (`child_process.spawn`, not
  `spawnSync` — a multi-second round-trip must never freeze the event loop / starve
  the heartbeat) and parses the `MODEL_ID=` line. **`buildProbeArgs` NEVER passes
  `--fallback-model`** (pinned by test): with a fallback configured, during an
  Opus OUTAGE the CLI returns the HAIKU id instead of erroring, and a naive
  "new id → respawn" would then SILENTLY DOWNGRADE every session to Haiku. With no
  fallback the CLI errors during an outage, which the watchdog treats as
  "probe failed → retry next tick" (the 6h gate is NOT advanced on failure/outage).
- **Detect (defense-in-depth + edge-triggered).** As a second guard,
  `isFallbackModel` rejects any probed id that is a known fallback/downgrade model
  (`getKnownFallbackModels()` = FAST/SONNET aliases, snapshot-stripped) as an
  outage, never a new model. The new-vs-known comparison is **snapshot-normalized**
  (`claude-opus-4-7-20260101` ≡ `claude-opus-4-7`). The baseline is the box's
  **configured** model (`getBestModel()`) on the first-ever probe, so a box sitting
  on 4.6 while 4.7 already shipped is detected on the first probe (the legacy harness's
  seed-silently-on-first-probe would have missed exactly that). `decideModelUpdate`
  is **edge-triggered**: it returns `notify` once per genuinely-new id, then
  `no-change` after adoption advances `last_known_model` (a 24h renotify re-nags an
  un-adopted model; a second, even-newer rollover inside the window notifies
  immediately so a stale version is never acked).
- **Adopt through the REAL config path.** On `notify` the watchdog flips the
  process-level `setBestModelOverride(newModel)` in `runtime/models.ts`, so every
  **fresh** persistent-REPL spawn resolves `--model` through `getBestModel()` and
  comes up on the new model — no redeploy, no env change ("auto-upgrade like
  Claude Code, applied to the model").
- **Always-latest model resolution (2026-06-30 — the opus-4-7 hang fix).**
  `runtime/models.ts` exposes ONE dynamic accessor, `getBestModel()` (the
  watchdog override when adopted, else the env/default seed). The frozen
  `BEST_MODEL` *constant* is the fresh-install **seed only** (bumped from the
  retired `claude-opus-4-7` to `claude-opus-4-8`) — it is bound once at module
  load and a runtime upgrade cannot mutate a `const`. **Every site that spawns a
  live REPL or dispatches a live-agent / onboarding turn now resolves the model
  through `getBestModel()` at the latest feasible point (per-turn / per-call, NOT
  captured when a runner is built once at boot):** the onboarding warm-pool
  pre-warm (`open/composer.ts` `prewarmSubstrate` — the spawn that HEATS the REPL
  and stamps `record.model`), the live-agent turn runner
  (`build-live-agent-turn.ts`, resolved inside the per-turn body), the onboarding
  post-turn extractor (`onboarding/interview/post-turn-extractor.ts`, resolves via
  `getBestModel()` — the successor to the deleted `build-llm-router.ts`/`llm-router.ts`
  after K11b1 #243), the project-opening / project-doc / phase-spec
  / agent-watcher composers, the one-shot Core LLM (`mount-open-cores.ts`), the
  onboarding suggesters + post-turn extractor, the synthesis/scribe/reflection
  defaults, and the import Pass-1/Pass-2 callers. The agent-dispatch
  `default_model` accepts a thunk so the Open composer passes the `getBestModel`
  accessor (resolved per-dispatch). **Why it matters:** a stale frozen id is a
  latent hang — the moment Anthropic retires the pinned model, a fresh install
  spawns a dead model, the turn produces zero tokens, and the persistent-REPL
  180s per-turn timeout fires (onboarding "Setting things up…" never resolves).
  The watchdog detecting the new model is necessary but not sufficient; the spawn
  sites reading `getBestModel()` is what closes the loop so the adoption actually
  reaches new/cold spawns. `claude-opus-4-8` is also added to
  `runtime/model-pricing.ts` (same Opus rates) so `resolvePricingFor(getBestModel())`
  at import-build time does not throw on the new default.
- **Graceful upgrade (idle-gated, never hard-bounce an active turn).** A
  round-robin `runGracefulUpgrade` loop moves each EXISTING warm session: each
  round checks every still-pending session once, respawning any that are idle and
  retiring any past its 30-min deadline, then sleeps and repeats (no head-of-line
  blocking). The idle gate (`isSessionIdleForUpgrade`) requires ALL four the legacy harness
  signals: **not mid-turn/typing** (`activeTurn` unset), **no tool-prompt pending**
  (`!wedgeRecovering`), **assistant quiet ≥30s** (`lastDataAt`), **JSONL cold ≥5s**
  (transcript mtime). An idle session's `record.model` is rewritten to the new id
  **BEFORE** the respawn (so `resumeSpecFor` → `--resume` re-attaches on the new
  model), then `respawnReplSession(..., 'model-update-watchdog', ...)` fires —
  context preserved via the resume-is-always-resume invariant.
- **Bounded.** ONE upgrade attempt per detected new id; a session that never idles
  within 30 min is **left on the old model** (logged, not force-killed) and picks
  up the new model on its next natural respawn. The probe/upgrade are
  in-flight-gated (one at a time) and the watchdog is idempotent per model-update
  state path.
- **Notice surface.** The detection fires the `onModelUpdate` DI seam once (edge)
  with `{newModel, oldModel, text}` (the Graceful framing); a gateway wires it to a
  dev-channel notice, else it logs to stderr. Mirrors the row #10/#11/#13
  notice-family seams.
- **Pure + injectable.** Every decision core (`buildProbeArgs`, `extractModelId`,
  `normalizeModelId`, `isFallbackModel`, `shouldRunModelUpdateCheck`,
  `decideModelUpdate`, `isSessionIdleForUpgrade`, `runGracefulUpgrade`,
  `startModelUpdateWatchdog`) is unit-tested without a process or PTY
  (`model-update-watchdog.test.ts`); the live wiring (`startModelUpdateWatchdogForInstance`)
  is exercised end-to-end against the real substrate
  (`model-update-watchdog-wiring.test.ts`: a new id → notice + adopt + respawn onto
  the new model; a fallback id → none of that).

This closes master-table **port row #16** (previously MISSING/P3) in
`docs/research/legacy-terminal-detection-keystroke-port-2026-06-25.md`.

## Stuck-typing reaper (port row #9) — VERIFIED-OBVIATED, no scraper

the legacy harness's #9 (`pane-scan-watchdog.ts decideStuckTypingAction` + `index.ts
recoverStuckTopic`) watched the tmux pane go byte-static with no active tool
call, scraped the last assistant block out of the pane, re-posted it with a
"recovered" banner, and `send-keys`-nudged the agent to call `reply()`. It
encodes **headless-pane invisibility**: anything the agent prints to the terminal
instead of calling `reply()` is invisible to the user, so the typing indicator
spins forever. A verify-first pass confirmed Neutron already covers this
**structurally**, so #9 ships as a doc note + verify test, **not** a scraper.

- **Turn-END case → `enforce-reply.ts` (the Stop hook), strictly better than
  scraping.** When a `<channel>` turn tries to end without a `reply()` tool call,
  the hook returns `{decision:'block', reason:…}` re-instructing the agent that
  *terminal output is invisible — call the reply tool now*. The lesson is applied
  **before** the content is lost rather than scraped back after, and the agent is
  forced to deliver via the one correlated path (`reply()` → one `completion`),
  never an un-correlated ring re-post.
- **Mid-stream byte-static sliver (the only thing the Stop hook can't see) is
  bounded elsewhere.** A turn that stalls mid-generation never reaches the Stop
  hook, but the substrate's unconditional per-turn `setTimeout(turnTimeoutMs)`
  (default 180s) fires a `retryable` error + closes the channel + poisons the warm
  session — the typing indicator **resolves** (no infinite spin), and the next
  dispatch lands on a clean REPL. Concurrently the 10s liveness keepalive re-runs
  `runOutputScan` each tick, so the *recoverable* cause of a static stall — a
  wedged interactive prompt — is cleared by the P0 detector (row #1).
- **Why no scraper, on purpose.** Re-posting scraped ring text would deliver
  content with no `turn_id`, which `onReply`'s correlation guard rejects by
  design (`[repl-sink] dropped uncorrelated reply`). Scraping would *regress* the
  reply()-only delivery guarantee the whole substrate is built on.
- **Verify test.** `enforce-reply.test.ts` (now 18, +3) pins the #9 turn-end
  shape: an agent that PRINTED its answer to the terminal and ended the turn is
  blocked; the block reason carries the headless-invisibility lesson
  (`invisible` + `terminal` + `reply`); a turn that DID call `reply()` is a clean
  no-op (nothing scraped, nothing re-posted).

This closes master-table **port row #9** as VERIFIED-OBVIATED in
`docs/research/legacy-terminal-detection-keystroke-port-2026-06-25.md` (was
PARTIAL/P2): the no-reply case is covered structurally and better; the mid-stream
sliver is bounded by the turn timeout + keepalive re-scan; no new code warranted.

## Autonomous overnight work (`onboarding/overnight/`) — runs ON Trident

The real overnight-work engine: while the user sleeps, the highest-priority
queued items for each project are dispatched, **each as its own Trident run**
(Forge→Argus→merge), and a morning brief reports the REAL result of every run.
This is the Neutron-Open (SQLite-native) port of the legacy harness's
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
(`checkContextGate`). Verbatim port of the legacy harness's hard gate, re-pointed from
`LEGACY_HOME` to the per-project repo root.

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

**Divergences from the legacy harness** (intentional): SQLite queue not JSON; cron-driven
not watchdog; each item is a Trident run (Forge→Argus→merge) not a single
substrate turn; documented 2/8 caps not the drifted 4/40; context resolved per
project repo not `LEGACY_HOME`.

**Known gap.** The overnight engine creates + polls REAL `code_trident_runs`
rows today. Whether those rows *advance* end-to-end in production is governed
by the Trident tick loop, which still boots on `stubAdvanceDeps` (classify
always "running") until the gateway credential closure is threaded into a live
`TridentDispatch` — Trident PR-5. Until then a production overnight run is
created + tracked but sits at `forge-init`; the full path (item → driven
Trident run → real result → morning brief) is proven by the overnight test
suite, which drives the run to terminal through the same store the engine
polls.

## Post-onboarding chat surface (`/ws/app/chat` → `appWsChatTurn` / `gateway/wiring/build-live-agent-turn.ts`)

Once onboarding reaches `phase==completed`, the chat surface is a normal
live-agent chat on EVERY topic — the General topic and each per-project topic
(`app:<owner>:<project_id>`) alike.

**Routing (server).** `/ws/app/chat` (`createAppWsSurface`,
`gateway/http/app-ws-surface.ts`) is the sole chat transport for the React owner
UI. In Open this is **Path 1 — ONE path**: every conversational frame — a typed
`user_message` AND a tapped `button_choice` — dispatches to `appWsChatTurn`, the
warm per-(project,topic) live CC session built by `build-live-agent-turn.ts`, on
General and each project topic alike. There is no `engine.advance` branch for chat
turns; the onboarding engine is retained ONLY for the import pipeline, and the
live agent's onboarding seam carries the interview until the owner is onboarded,
then it is steady-state chat. A free-Core slash command is intercepted first by
the chained `chat_command_filter` (`app-ws-surface.ts:605` / `:783`).

**Owner-timezone capture on connect (ISSUES #40, WRITE path landed #392).** The
web + Expo clients detect their own IANA zone client-side
(`Intl.DateTimeFormat().resolvedOptions().timeZone` via `detectClientTimezone` —
web captures it ONCE at boot and stores it on `config` (`landing/chat-react/config.ts`),
mobile re-evaluates it per connect as a default arg of `buildWsUrl`
(`app/lib/chat-core/ws-url.ts`)) and report it as `tz=` on the `/ws/app/chat`
upgrade query string. The server boundary-sanitizes it
(`sanitizeTimezone`, `channels/adapters/app-ws/envelope.ts`), then — once per WS
`open`, in the `on_client_timezone` handler (`open/wiring/app-ws.ts`) — is
AUTHORIZED by owner identity: only `user_id === OWNER_USER_ID` proceeds (a
non-owner guest on a shared instance is ignored — logged server-side, no
client-visible error — since one instance `project_slug` binds many `user_id`s).
It then idempotently persists a valid, changed zone via
`persistOwnerTimezoneIfChanged` → `writeOwnerTimezone`
(`gateway/storage/owner-metadata.ts`), the row keyed on the auth-resolved instance
`project_slug` (never a client-supplied identity). Its consumers are **every
scheduled owner-facing surface** — the P6.1 nudge pick's day boundary, the
proactive morning brief's hour gate + day key, the idle-nudge sweep's day key,
and recurring reminders — each reading it per tick via `readOwnerTimezone` in
`gateway/composition/build-core-modules.ts`. See § "Which clock the daily rhythm
runs on" for the precedence and why the read must be per-fire. A legacy client
that reports no `tz` performs no write, leaving any previously stored zone
unchanged; with no stored metadata the proactive crons fall back to the host's
zone (correct for a self-hosted install) and the nudge engine to
`DEFAULT_OWNER_TIMEZONE`.

> K11b0 (2026-07-06): the legacy `/ws/chat` `ChatBridge` this section once
> described (`handleInbound` / `isLiveAgentEligible` / `handleProjectTopicInbound`,
> client `landing/chat.ts`) was excised — it was fully dead in production. The
> dated GO-LIVE notes below reference that removed bridge as historical context;
> the live-agent turn mechanics they cite (per-(instance,topic) serialization,
> first-turn system-prompt composition) live on unchanged in `build-live-agent-turn.ts`.

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
   every turn" doctrine (`gateway/wiring/operating-doctrine.ts`):
   truth-first, essence-over-excess, calibrated confidence, explicit
   anti-sycophancy / pushback discipline, and a grounding ("dharma") reframe used
   only when it genuinely fits. Composed consistently on EVERY topic, independent
   of whatever the generated SOUL text happened to contain, and per-context
   weighted (General → cross-project breadth; a project topic → that project's
   craft, lighter reframes). It is a FLOOR, not a ceiling — the fragment defers to
   any sharper rule the owner's SOUL states. Spliced into both the assembled path
   and the degraded fallback, so the floor never depends on `assembleSystemPrompt`.
   Two named rules ride alongside the numbered principles:
   `BUILD_ROUTING_DOCTRINE` (self-route simple↔inline / complex↔trident) and
   **`MISSING_CREDENTIAL_DOCTRINE` (#552)** — when a capability is blocked by a
   missing credential, NAME the in-product surface the owner can reach to supply
   it (the Integrations surface), and never answer with a shell command as the
   remedy, because the owner cannot be assumed to have a terminal on the machine
   the agent runs on. It names GitHub concretely, because the failure that
   produced the rule was a `git push` / PR creation dying for want of a token
   while the agent recommended `gh auth login`. Phrased UNCONDITIONALLY — there
   is no branch on deployment shape, since naming the surface is the right answer
   either way and a branch is only something for the model to get wrong. Asserted
   against the COMPOSED prompt (`build-live-agent-turn.test.ts`), not only against
   the module: a rule nothing splices in is the same defect one layer up.
3. `<project_persona>` — WAVE 2 Track A: a project topic's own `projects.persona`
   voice, refining the register for that project (never for General).
4. `<live_agent_context>` — the this-turn scope block + a `<recent_conversation>`
   short-term-memory splice.

**Client surface — historical (the vanilla `landing/chat.ts` web client, excised
K11b0 2026-07-06).** The live owner UI is the React client (`landing/chat-react/`,
e.g. `ChatApp.tsx`) on the `/ws/app/chat` app-ws transport (see "Routing (server)"
above); the notes below describe the RETIRED vanilla client and are kept as
historical context for the loader / topic-switch / envelope-routing invariants
that carried over (the surviving live-agent mechanics live in `build-live-agent-turn.ts`).
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
- *Per-topic envelope routing (P1a, 2026-06-26).* The web client multiplexes
  every topic over ONE socket and runs a per-topic drop-guard: it only paints a
  message whose `topic_id` matches the focused topic (otherwise it routes to that
  topic's own view / hydrates on switch). So EVERY outbound web envelope stamps
  the destination `topic_id` — the live-agent reply + cold-start/failure bodies
  (`build-live-agent-turn.ts`), the wow `sendText`/`emitPrompt` (`build-wow-dispatcher.ts`
  — this dead wow-push cluster was deleted in K11d #248), the recovered-reply replay
  (`recovered-reply-store.ts`), and the chat-bridge command/failure/`agent_ack`/
  `error`/slug-rename envelopes (`chat-bridge.ts`). Without it an async
  notification (a wow-moment, a reconnect-replayed recovered reply) painted into
  whatever topic was focused (cross-project bleed). The app-ws (Expo mobile)
  surface carries `project_id`/`message_id` on its own envelope shape instead.
- *Wow brief persistence (2026-06-20) — since DELETED (K11d #248).* The wow
  channel adapter's `sendText` (`buildWowChannelAdapter`) persisted every
  delivered agent statement — notably action 01's first-week brief — to
  `button_prompts` as an inert, already-resolved agent-bubble turn so it survived
  a reload. The wow-push cluster (`buildWowChannelAdapter`, action 01
  `01-first-week-brief.ts`, `appendOvernightPreview`) was dead-in-prod and was
  deleted in #248; only wow-moment actions 04–07 remain.
- *Truthful first-week brief (2026-06-20) — DELETED with the cluster above (#248).*
  Action 01's overnight section (`appendOvernightPreview`)
  read the REAL `overnight_queue` for the project at render time
  (`OvernightQueueStore.listByProject`, filtered to `queued`/`in-flight`): it
  reflected genuinely-queued rows when present, and otherwise OFFERED overnight
  work / reminders rather than asserting a schedule, never claiming scheduled
  overnight work or set reminders unless the real tables backed it.
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
loop (the legacy harness's diary + `corrections-log.md` mechanism, Neutron-native for a
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

## React web chat client (`landing/chat-react/`, Track B Phase 3) — the only web chat client

> **P0b (2026-06-26) — no flag, no vanilla path.** The old vanilla-TS client
> (`landing/chat.ts`, served on the legacy `/ws/chat` surface) and the
> `NEUTRON_WEB_CHAT_CLIENT` / `?client=` flag (`landing/web-chat-flag.ts`) were
> **deleted** (Ryan-locked: no feature flags, no dual path). `GET /chat` now
> **unconditionally** serves the React shell; a fresh single-owner Open install
> always gets the tabbed React UI with no env var. See "Web client consumption"
> above for the current serving contract (`landing/server.ts:1205`).

React + `@assistant-ui/react` (MIT, bring-your-own-transport) is the web chat
surface, reusing the Phase-1 `@neutronai/chat-core` sync engine.

**Transport.** The React client connects through chat-core's `WebChatSession`
to the **app-ws** surface (`/ws/app/chat`, `app:<user_id>` topic) — a
monotonic per-topic `seq` + `resume after_seq` replay + the OPFS/wasm local
Store. Identity is derived client-side from the start-token `sub` claim; the
app-ws token defaults to the dev-bypass form (`dev:<user_id>`) and is
overridden by `window.__neutron_app_ws_token` once the production EdDSA mint
lands.

**Serving.** `GET /chat` always serves `chat-react.html` (loads
`/chat-react.js`); the landing server lazily bundles it from
`chat-react/main.tsx` via `Bun.build` (minified, ~0.6 MB — React + assistant-ui
+ chat-core) or serves a pre-built `chat-react.js` if present next to the HTML
(`landing/server.ts` — see "Web client consumption" above). `chat-react.html`
is REQUIRED at boot: its absence throws rather than falling back to a
now-nonexistent vanilla client.

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
- **Root-level auto-recovery (#380).** `main.tsx` mounts via `mount()`, which
  wires `createRoot(rootEl, { onUncaughtError })` (React 19.1). The per-pane
  `PaneErrorBoundary` + `ChatErrorBoundary` only catch errors thrown during a
  child RENDER; a setState-after-unmount surfaces in a real browser commit as
  React's teardown-phase fiber invariant, thrown from React's own commit phase,
  which bypasses every boundary and unmounts the whole root (the historical
  blank screen). `onUncaughtError` is the one hook that fires for that class, so
  it consults a bounded crash policy (`createRecoveryPolicy` — ≤3 remounts per
  rolling 60s) and schedules recovery on a macrotask: an auto-remount reuses the
  SAME controller + OPFS store (both live outside React, so the transcript +
  session survive), and once the budget is exhausted it paints a visible error
  card with a Reload button (`.car-fatal`) — never a silent blank. This is the
  root net BEHIND the per-pane unmount guards (`mountedRef` + abort-reads across
  DocumentsTab, IntegrationsTab, SettingsTab, WorkBoardTab, ChatApp), which stop
  the setState-after-unmount at the source.
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
- **Accepted types (M2 modality scope, 2026-07-21):** PNG / JPEG / GIF / WEBP
  raster images + **PDF documents** (`CHAT_UPLOAD_MIME_WHITELIST`). SVG stays
  excluded (inline-script XSS). Magic-byte sniffing (`gateway/storage/binary-types.ts`)
  is authoritative — a declared type that disagrees with the sniff is a 400
  `content_type_spoof`. A NON-image attachment renders in the bubble as a
  downloadable file chip (not a broken image) via the SAME authed fetch — on BOTH
  surfaces: web (`message-adapter.ts` routes every attachment through the authed
  renderer, which branches on `isImageAttachmentUrl`) AND mobile
  (`app/components/AuthedAttachmentImage.tsx` delegates non-images to
  `AuthedAttachmentFile`, a tappable `📎` chip; `app/lib/attachment-url.ts` holds the
  shared `isImageAttachmentUrl` / `attachmentBasename` predicates). Served blobs pin
  `X-Content-Type-Options: nosniff` + `Content-Disposition: inline` so a browser never
  MIME-sniffs a document into an executable type. The native picker's accept list
  mirrors the server whitelist.
- **Attachment → agent threading (M2, 2026-07-21):** the upload URLs are no longer
  dropped at the WS receiver. `open/wiring/app-ws.ts` sanitizes
  `adapter_metadata.attachments` (via `sanitizeInboundAttachments` — non-empty strings,
  deduped, capped at `MAX_INBOUND_ATTACHMENTS`=16) and passes them on the
  `LiveAgentTurnRequest`; `gateway/wiring/build-live-agent-turn.ts` resolves each
  URL to its local blob path (`resolveChatAttachmentLocalPath`, supplied by the
  composer over `owner_home`) and splices a `<user_attachments>` fragment of the
  resolved absolute paths into the DISPATCHED prompt (warm splice + cold
  `composeFirstTurnPrompt`) — the CC REPL `Read`s images AND PDFs natively. The
  fragment is prompt-only; `turn.user_text` (which feeds capture/reflection/
  scribe/persistence) is never mutated. An attachment-only send still dispatches a
  turn; an unresolvable URL is skipped with a warn.
- **Voice notes (M2 task 5, 2026-07-22):** audio (MP3 / M4A / WAV) is accepted on
  the SAME chat-upload surface as images + PDF (`CHAT_UPLOAD_MIME_WHITELIST` +
  `EXT_FROM_MIME` + `URL_PATH_RE` + `mimeFromExt` all widened; the sniffers already
  existed in `binary-types.ts`). At upload-complete an audio blob is transcribed by
  `gateway/transcription/openai-transcription.ts` — an OpenAI-compatible `POST
  {base}/v1/audio/transcriptions` Whisper client (`whisper-1`, injectable base_url +
  fetch; typed error taxonomy; never throws). Which backend
  answers is the owner's SETTING — see § "Voice-note transcription", now the
  authoritative account. (Superseded here: this paragraph originally said
  transcription was "gated ONLY by `OPENAI_API_KEY` presence". Since migration
  0111 the gate is `instance_metadata.transcription_backend`, and the key is an
  owner-entered credential in the encrypted store, with the env var kept only as
  a fallback SOURCE.) The transcript is persisted as
  a **content-addressed `<hash>.txt` sidecar** beside the blob (atomic tmp+rename,
  idempotent — a re-upload of the same bytes never re-calls the API; `.txt` is
  deliberately NOT in the GET ext-group, so the sidecar is never servable). It is
  injected into the `<user_attachments>` prompt fragment as the voice note's inline
  transcript (capped at 4000 chars; unconfigured/failed ASR → a graceful "transcription
  unavailable" note), and appended to the SCRIBE text via a new
  `attachmentTranscript` app-ws seam so voice → text → gbrain memory reaches parity —
  the turn's `user_text` is never mutated. Both clients render a 🎵 chip for a voice
  note (web `message-adapter.ts` `isAudioAttachmentUrl`; native `attachment-url.ts`
  predicate; icon precedent `docs-shared.ts` `treeIconFor`).
- **Recording a voice note on mobile (2026-07-31):** the half above accepted audio
  but nothing could CAPTURE it — the app had no audio dependency at all, so a voice
  message could only be sent by picking an existing file. Recording now lives in
  four new modules, deliberately split so the gesture rules are testable off-device:
  `app/lib/voice-recording.ts` (pure — the `M:SS` clock, the slide-to-cancel
  arithmetic, the min/max duration rules, the capture settings), `app/lib/voice-send.ts`
  (upload orchestration — validates then calls the EXISTING `uploadAttachment`; no new
  endpoint), `app/lib/use-voice-recorder.ts` (**the seam**: permission, `expo-audio`
  lifecycle, elapsed clock, upload handoff), and `app/components/VoiceRecorderOverlay.tsx`
  (the pixels — the recording / review / uploading / error row that covers the
  composer). The dependency is **`expo-audio@~1.1.1`**
  (SDK-54-matched; `expo-audio` supersedes `expo-av`), configured via the
  `expo-audio` config plugin in `app.json`, which adds `RECORD_AUDIO` +
  `MODIFY_AUDIO_SETTINGS` on Android and `NSMicrophoneUsageDescription` on iOS —
  **native config, so it ships only in a new BUILD, never an OTA update**.
  Both iMessage gestures run off one button and one recorder: a HOLD sends on
  release (and discards if the finger slid past the composer's cancel threshold,
  the mic filling accent → danger as it travels), while a TAP latches capture
  hands-free and the overlay grows a ■ stop that drops the clip into a play / ✕ /
  send review row. Capture is
  22.05kHz mono AAC in `.m4a` at 32kbps — speech settings, since the ASR model
  resamples anyway — capped at 10 minutes, which stays well inside
  `MAX_CHAT_UPLOAD_BYTES`.
- **…and WIRED into the chat surface (2026-07-31):** everything above shipped
  unreachable. `ChatSyncSurface` — the one chat screen — passed none of
  `InputComposer`'s four voice callbacks, so the mic answered every press with
  "Voice messages are not available yet", and the recorder, the overlay and the
  upload path had no call site outside their own tests. The join is
  **`app/lib/voice-composer-handlers.ts`**: a pure `voiceComposerHandlers(voice)`
  that translates the composer's gesture vocabulary (`onVoiceTap` /
  `onVoiceHoldStart` / `onVoiceHoldMove` / `onVoiceHoldEnd`) into the recorder's
  (`start` / `latch` / `updateDrag` / `finish` / `cancel` / `stopForReview`).
  Being a pure function of the recorder value, the whole mapping is asserted
  call-for-call in `app/__tests__/voice-composer-handlers.test.ts` without a
  device or a mounted surface. `ChatSyncSurface` now calls `useVoiceRecorder`
  (`onSend` → the SAME `send('', [url])` an image upload takes; `onPermissionBlocked`
  → `Linking.openSettings()`), spreads the handlers onto the composer, and renders
  `<VoiceRecorderOverlay>` immediately above the composer bar — the mic button
  stays mounted beneath it because in long-press mode the finger is still on it.
  A phase that belongs to the overlay (review / uploading / error) makes the mic
  inert rather than letting a stray tap destroy an unsent clip.
  `app/components/VoiceMicButton.tsx` was DELETED in the same change: it was a
  second, never-rendered mic control whose emoji glyph and filled resting circle
  contradicted the iMessage composer's drawn `MicGlyph`, and two mic buttons is
  exactly the dual code path this repo forbids. One button, one recorder.
- **…and capture now opens on TOUCH-DOWN, not on the long-press verdict
  (2026-07-31):** the wiring above started the recorder from `onLongPress`, and
  the mic carries `delayLongPress={250}`, so for the first quarter-second of
  every hold the gesture recogniser was deciding "tap or hold?" with the
  microphone still shut. People begin talking as they press, so a held message
  opened mid-syllable. Measured on the device harness — real `Pressable`, real
  250 ms classification delay, real clock — a 904 ms hold returned **599 ms of
  audio: 305 ms lost**. Nothing about opening the microphone depends on the
  verdict, so it no longer waits for it. `InputComposer` gained a FIFTH voice
  callback, **`onVoicePressIn`**, fired from the button's `onPressIn`; the same
  900 ms hold now returns 853 ms, a 52 ms lead-in that is permission +
  audio-session + native prepare rather than a gesture delay. Lowering
  `delayLongPress` was rejected as the fix: it makes deliberate taps read as
  holds and still never reaches zero. **The verdict now decides what happens TO
  the recording rather than whether it exists** — a hold keeps what touch-down
  captured, a tap `latch()`es it (the early audio is a head start, and the
  overlay's ■ appears because the finger is gone), and a press that wandered off
  the control routes to `cancel()`. That last edge is the new hot-mic obligation
  and it is why the release edge, not `onPress`, resolves a short press: `onPress`
  does not fire for a press that left the button, so a recording waiting on it
  would run on unstoppably. The invariant is now structural — **every touch-down
  that opened a capture reaches a terminal edge at `onPressOut`**: hold-end,
  cancel, or latch-with-a-stop-control. None of the three is a hot mic. Pinned by
  `app/__tests__/voice-capture-starts-on-touch-down.test.tsx`, which reports the
  lead-in and the lost-audio figures as real milliseconds so a regression reads
  as a number, and by the `record()`/`stop()` timestamps the `expo-audio` harness
  stub now records.
- **ISO-BMFF audio is no longer mistaken for video (2026-07-31):** `magicByteSniff`
  classified `ftyp` files on the major brand alone, so a GENERIC brand meant
  `video/mp4` — a type absent from `CHAT_UPLOAD_MIME_WHITELIST`. Android's
  MediaRecorder stamps `mp42` on every MPEG-4 file it writes, audio-only voice notes
  included (and desktop muxers commonly write `isom` for a plain `.m4a`), so those
  uploads 415'd. `isoBmffTrackKinds` (`gateway/storage/binary-types.ts`) now walks
  the box tree to `moov > trak > mdia > hdlr` and reads the track handlers: `soun`
  with no `vide` ⇒ `audio/mp4`. It is a STRUCTURAL walk stepping box-to-box by size
  (handling both the `size == 1` 64-bit and `size == 0` to-EOF escapes), not a byte
  scan, so `hdlr` bytes inside an opaque `mdat` cannot forge a track — and it finds
  `moov` whether it precedes the payload or trails it, which is the layout
  MediaRecorder writes. An unparsable file keeps the historical `video/mp4` answer
  rather than guessing.

**Parity reached:** optimistic send, token streaming, typing indicator,
reconnect+backoff (all via chat-core), durable cold-open + gap-free reconnect
(seq/resume), multi-device (falls out of seq/resume + the Phase-1 `Set<sender>`
registry), project topics, attachments (compose **and** authed render), and voice
notes (audio upload + Whisper transcription → prompt + scribe).
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
the app-ws auth resolver itself notes). These are deferred enhancements to the
(now unconditional) React client — the vanilla client is deleted; the forward-only
resume contract holds until they land.

**Tests.** `chat-react/__tests__/` — controller integration over a real
`WebChatSession`+fake socket, pure adapter + bootstrap-config tests, and a
happy-dom component smoke test that renders the full assistant-ui composition
and asserts an optimistic send + a streamed-then-finalized agent reply reach the
DOM. `chat-react/__tests__/uploads.test.ts` covers the upload client (bearer
multipart POST, pre-flight size/type rejection, server error codes, abort,
authed GET→object URL) and `attachments.test.tsx` the full stage→upload→send→
authed-render flow. `landing/__tests__/chat-react-serving.test.ts` covers the
unconditional `/chat` + `/chat-react.js` serving. The React leaf typechecks via
`landing/chat-react/tsconfig.json` (`bunx tsc -p
landing/chat-react/tsconfig.json`) — isolated from the root deploy gate, which
has no JSX/React and (since the flag's removal) does not include `landing/**`
at all; `landing/` has its own leaf config (`landing/tsconfig.json`), both
checked by `scripts/ci/typecheck-all.sh`'s dynamic tsconfig matrix.

## Onboarding project removal ("ignore X")

At `projects_proposed` the freeform reply is processed by the onboarding post-turn
extractor (`onboarding/interview/post-turn-extractor.ts` — successor to the deleted
`llm-router.ts` after K11b1 #243). It extracts a transient `removed_projects` array,
subtracts those names from `phase_state.primary_projects`, AND records the explicit
drops under `phase_state.dropped_projects` (additive across turns; a later explicit
re-add of a name clears its prior drop). At finalization, `resolveProjects` in
`onboarding/openings/finalize.ts` EXCLUDES `dropped_projects` from BOTH union sources
(`phase_state.primary_projects` and the import's re-pulled `proposed_projects`) so a
named project is never materialized — the deleted engine/router no longer performs this
merge. Removal verbs include drop / cut / skip / remove /
**ignore / exclude / leave out / don't set up** (the last four added 2026-06-20
after "ignore real estate investing" was acknowledged but not honored). Projects
are also renameable/deletable later from settings — the prompt copy says so.

## Skill Forge — auto-skillify completed workflows (`skill-forge/`)

Skill Forge turns a workflow the agent ran *once* into a saved, re-invokable
skill, so repeated multi-step work compounds instead of being re-derived each
time. It is **gated by propose-then-approve** — it never creates a skill
silently.

- **Audit (`detector.ts`).** When a multi-step workflow completes, `auditWorkflow`
  decides if it is skill-worthy: it must have succeeded and be a real procedure
  (≥2 *distinct* normalized actions, not one tool run repeatedly).
- **Propose (`forge.ts` + `proposal-message.ts`).** `SkillForge.onWorkflowCompleted`
  persists a **pending** row in `skill_forge_proposals` (migration `0086`) and
  surfaces a proposal — name + triggers + what-it-does + artifacts — via an
  injected `ProposalNotifier`. Nothing is written to disk yet. A stable
  `workflowSignature` dedupes, so a workflow run repeatedly does not re-nag.
- **Approve → register (`distiller.ts` + `registrar.ts`).** On approve (optionally
  with edits), the workflow is **distilled** deterministically into a native
  `SKILL.md` pack (`renderSkillPack` — YAML frontmatter + body) and written to
  `<owner_home>/.claude/skills/<name>/SKILL.md` — the SAME project skills dir the
  spawned REPL discovers natively (P1-5). So the new skill is immediately
  discoverable + invokable via the built-in `Skill` mechanism and, being on disk,
  **survives a fresh session**. Decline marks the row declined and creates nothing.
- **Trigger source (`trident-adapter.ts`).** `completedWorkflowFromTridentRun`
  maps a terminal `done` Trident run into the generic `CompletedWorkflow`.

### Composed into the Open boot path (parity gap #5) — `open/composer.ts`

Skill Forge is **wired into the single-owner daily-driver** (it was built-but-unwired
until this — `docs/research/legacy-neutron-feature-parity-scan-2026-06-25.md` §2.R/§5.5).
The composer mirrors the gap-#2 Cores (`mount-open-cores.ts`) + gap-#3 agent-dispatch
shape: it constructs ONE `SkillForge` + `SkillForgeProposalsStore` over the per-instance
ProjectDb, plus a `SkillForgeBackend` the tool **and** chat command share. **No feature
flag; built unconditionally so the manage surface works even on an LLM-less box.**

- **The auto-propose trigger.** The composer threads `trident.on_run_terminal` onto
  `CompositionInput`; `gateway/composition/build-core-modules.ts` chains it into the
  Trident tick loop's terminal hook (after delivery), so a `done` run fires
  `skillForge.onWorkflowCompleted(completedWorkflowFromTridentRun(run))` (the audit
  drops non-`done` runs). Failure-safe: the trident module wraps the call in try/catch.
- **Agent-native surface (one backend, two front doors).** `skill_forge_list` (read-only,
  `read:project_data`, `auto`) + `skill_forge_decide` (`write:project_data`, `prompt-user`)
  MCP tools (`skill-forge/tool.ts`, registered by the `tools` module when
  `composition.skill_forge` is set) AND a `/skills` chat command
  (`skill-forge/command.ts`, a `ChatCommandFilter` chained into `buildLandingStack`
  alongside the Cores filters). Both call the SAME `SkillForgeBackend` — the agent can
  list / approve / decline exactly what the owner can.
- **Notifier — the proposal is DELIVERED into the owner's chat.** The composer's
  `ProposalNotifier` posts the proposal message through `deliver(topic, envelope)`
  (`gateway/http/deliver.ts`, the ONE out-of-turn delivery seam) on the owner's bare
  `app:<owner>` topic, at **`durability: 'inert'`** — an already-resolved agent history
  turn (speaker `__system__`), the same shape the `/api/app/system-notice` route and the
  proactive brief use. `'inert'` and not the transient `'none'` pill because a proposal
  is produced when a Trident run *finishes*, exactly when nobody is watching; a live-only
  bubble would be gone by the time he opened the app. It is a **system notice, not the
  owner speaking** — it does not route through chat/send and spends no model turn.
  Delivery is **additive**: the row is persisted before notify and `forge.ts` swallows a
  notify throw (`proposal_persisted_but_notify_failed`), so the `skill_forge_proposals`
  row stays the source of truth and `/skills list` is unchanged. **One message per
  proposal, and a run yields at most one** — `onWorkflowCompleted` creates a single
  proposal and returns early on a duplicate `workflowSignature`, so a repeated workflow
  re-notifies zero times. The message quotes the real decision surface
  (`/skills approve|decline <id>`) with the proposal's own id.
  - *Superseded:* this notifier was previously a `log.info`-only sink, justified by
    "Open is WS-native + single-owner, no Telegram channel". That premise expired when
    F5 landed `deliver` — Open **does** have an out-of-turn channel. The log-only sink
    meant a proposal was drafted, persisted, and never announced: the owner could only
    find one by typing `/skills`, i.e. by already suspecting it existed. Gate:
    `open/__tests__/open-skill-forge-wiring.test.ts` asserts the durable turn lands in
    the owner's topic (mutation-verified — deleting the `deliver` call fails it).

## Testing & CI — the bounded-memory partitioned runner (`scripts/run-tests.sh`)

CI runs `bash scripts/run-tests.sh` (`.github/workflows/ci.yml`), the one
documented command for the **whole** suite. `bun test` loads every file into one
long-lived process whose peak RSS OOMs the contended 30 GB deploy box (ISSUES
#78); the runner **partitions** the suite (hundreds of files and growing — run
the script and read its own startup line for today's live count) into chunks
and runs each chunk in its own fresh `bun test` process, so peak RSS is bounded
to a single chunk and freed between chunks. Coverage is **audited** — every discovered file runs once,
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

## Reachability gate — can the owner still DO it? (`*/__tests__/reachability*`)

**The class of bug it exists for.** Every regression that has reached the owner in
a green build had one shape: **a part worked, and the product could not reach
it.** A voice recorder whose host screen never passed it its props, so the mic
answered "not available yet". A usage meter absent from the wide layout because
the wide branch stopped passing `usage` — and no test had ever rendered a wide
layout. A `/code` command that was written, unit-tested and merged, and never
added to the composer's filter chain, so every `/code` went to the model. A unit
test asserts that a PART works; nothing asserted that the PRODUCT still reaches
it, and unit coverage is structurally blind to the difference.

**What the gate does.** It declares, as data, what the owner must be able to do —
and proves each one against the real thing, in the owner's language.

- **`landing/chat-react/__tests__/reachability-inventory.ts` + `reachability.test.tsx`** —
  mounts the REAL app shell (`ProjectShell`, the component `main.tsx` renders,
  with the real controller, chat session, tab resolver and usage client; fake
  socket, injected fetch, no model) at **every layout the product ships** (narrow
  390px, wide 1440px) and probes each affordance: compose, send, send-becomes-
  usable-once-typed, attach, project rail, tabs, usage meter, theme control,
  Connect GitHub. The last one added a third probe PHASE (`inAdmin`): the things
  you ADJUST live behind the header menu rather than in the tab band
  (`ProjectShell`'s `MENU_TARGETS`), so the probe walks the owner's real path —
  open the menu, choose Admin — before looking, and those two steps are part of
  what is being asserted. It joined because #551 was the purest example of the
  class this gate exists for: a complete, tested, mounted GitHub device-flow
  backend that no client called, so the owner could not start it and the agent
  told him to use a terminal he does not have.
- **`open/__tests__/reachability-inventory.ts` + `reachability.test.ts`** — boots
  the REAL Open composition over a live `Bun.serve`, opens the unified
  `/ws/app/chat` socket and TYPES each declared command with a mocked substrate.
  A command must be **claimed** by the composed chain (a `chat_command_result`
  correlated to the message id) and must **not** reach the model. Currently
  probed: `/status`, `/reset`, `/code`, `/skills`, `/email`, `/research`,
  `/remind`, `/cal`. The last two joined on 2026-08-03, closing the only two
  entries the inventory had ever admitted were a REAL COVERAGE GAP rather than a
  design choice. Both are probed with the BARE command, which is what made them
  probeable: `/remind`'s exclusion was that a phrasing-dependent probe is
  ambiguous between "unwired" and "stopped parsing", and `/cal`'s was that
  dispatching into the calendar Core is not deterministic without Google
  credentials. The bare form has no phrasing to get wrong and answers from the
  parser's `help` branch WITHOUT touching the calendar client, so the probe reads
  identically on a fresh install and a connected one. Same technique `/code help`
  already used. There are now NO exclusions on the grounds of coverage — the
  three that remain are the chain combinator itself and the inner `/cal`
  dispatcher, each excluded because it is genuinely covered by another probe.
  It also types the commands the inventory admits are BROKEN
  (`CHAT_COMMANDS_KNOWN_UNREACHABLE`) and asserts they are still unclaimed — so
  the day one is wired, the gate reds and demands a real probe rather than
  leaving a stale note behind. Today that list holds `/scrape` (see below).
- **`open/__tests__/reachability-inventory-complete.test.ts`** +
  **`open/__tests__/chat-command-filter-scan.ts`** — the piece that makes it
  self-extending. The scan reads every non-test `.ts`/`.tsx` under the repo
  (minus `node_modules`, `vendor/`, build output) with the TypeScript parser and
  collects every exported function whose **name or declared return type** ends in
  `ChatCommandFilter`; the gate fails when one is neither probed, nor pinned as
  known-broken, nor excluded **in writing, with a reason**. A new `/`-command
  turns this red on the PR that adds it.
  **It was blind until 2026-08-02, and the shape of that blindness is worth
  keeping.** It used to read ONE hardcoded file with ONE `build…` regex: it saw
  6 factories, the product had 11, and 5 of the 5 it missed were live in the
  chain — so unwiring `/skills`, `/email`, `/research` or either half of `/cal`
  reddened nothing, which is the exact `/code` failure the gate was built to
  prevent. It was defeated by LOCATION (filters outside that file), by NAMING
  (`create…` rather than `build…`), and by `buildCalendarChatCommandDispatcher`,
  which names the concept only in its return type. The scan now **refuses
  loudly** — a root with no sources, sources that never mention the contract, or
  a filter declared as a `const` all throw rather than reporting an empty set,
  each with its own fixture test. What it still cannot see is written at the top
  of the scan file; read that before trusting it.
  **Known gap it surfaced: `/scrape` is unreachable.**
  `createScrapingChatCommandFilter` (`cores/free/scraping/src/chat-bridge.ts:40`)
  is built by `buildProductionScrapingCoreWiring`
  (`cores/free/scraping/src/wiring-production.ts:63`), which nothing calls — the
  composer wires the research Core's equivalent
  (`gateway/cores/mount-open-cores.ts:312,397`) and never the scraping one. The
  Apify-backed MCP tools still work, so the capability is reachable by the AGENT
  and not by the owner, breaking the agent-native parity claimed for this Core in
  one direction. Fixing it means threading a scraping backend to the chain at
  mount time.
- **`app/__tests__/reachability-inventory.ts` + `reachability.test.tsx`** — the
  MOBILE half, and the one that covers the voice incident directly. It mounts the
  REAL project shell (`app/projects/[id]/_layout.tsx` over the routing harness,
  with the real header, rail, tab bar, usage client and the real
  `ChatSyncSurface` inside `<Slot/>`) on **every platform the app ships** (ios,
  android) and probes eleven affordances: compose, send, tap-to-record,
  hold-to-talk-and-slide-to-cancel, attach, switch project, create project, tabs,
  project settings, app settings, usage meter.
  **It PRESSES rather than queries, and that is the whole design.** A presence
  probe ("is the mic in the tree?") PASSES on the build that shipped broken — the
  mic was in the tree, it rendered perfectly, and it did nothing, because
  `ChatSyncSurface` mounted `<InputComposer>` without its `onVoice*` props. So
  every probe ends at an effect a missing handler cannot fake: a microphone that
  opened, a frame on the socket, an OS picker that ran, a route that changed, a
  measured meter. Each affordance gets a FRESH shell (a recording replaces the
  composer, a tap changes the route, a drawer covers the screen — sharing a mount
  would make results order-dependent, and an intermittent gate gets muted).
- **`app/__tests__/reachability-inventory-complete.test.ts`** — mobile's
  self-extension, two source scans. (1) Every OPTIONAL callback `InputComposer`
  accepts must be exercised by an affordance or excluded in writing — an optional
  callback a host forgets is *exactly* the voice defect, so the next one cannot
  ship the way `onVoiceTap` did. (2) Every width branch in the app must be
  `Platform.OS === 'web'`-gated, or recorded with a reason; see the parity note
  below for why that matters.

- **The press-the-control files, for surfaces outside the two shells.** The
  inventories probe the CHAT shells; a screen reached by its own route gets a
  dedicated file that presses instead — `app/__tests__/model-providers-reachable.test.tsx`
  (Codex, Kimi) and, for GitHub, the pair
  `landing/chat-react/__tests__/github-connect-reachable.test.tsx` +
  `app/__tests__/github-connect-reachable.test.tsx`. Same rule as the mobile
  inventory: find the control, press it, and demand an effect a missing handler
  cannot fake — a POST on the wire, a code on screen, a clipboard write, a URL
  handed to `Linking`, a poll that flips the screen to connected and then stops.

**Two design rules it is built on.**

1. **Parity across everything the product ships.** On web that axis is layout
   width: an affordance reachable at one width and missing at another fails,
   unless the inventory carries a written `absentIn` reason (today exactly one —
   the theme toggle, deliberately narrow-absent per #350/#360).
   **On mobile the axis is PLATFORM, not width, and that is a verified finding
   rather than a shortcut.** Every width branch in the app is
   `Platform.OS === 'web' && width > BREAKPOINTS.narrow_max`
   (`app/projects/[id]/_layout.tsx:417`, `ProjectTabBar.tsx:80`,
   `ProjectSettingsDrawer.tsx:263`, `CommentsSidePane.tsx:143`,
   `FocusList.tsx:97`, `ReminderList.tsx:81`, `TaskList.tsx:65`) and `web` is not
   a shipped platform (`app/app.json` → `ios`, `android`), so the app renders ONE
   layout at every size on a phone or a tablet; a width matrix there would be two
   identical runs wearing a matrix's clothes. What the app does branch on is the
   platform (`use-keyboard-inset.ts:127`, `ActivityInspectorDrawer.tsx:371`,
   `ProjectSettingsDrawer.tsx:329`), so parity is enforced across ios/android
   instead. Nobody has to remember this: the completeness gate re-derives it from
   the source every run and reds the day a non-web-gated width branch appears,
   demanding the width axis back. (The only one today —
   `app/projects/[id]/backups.tsx:97` — is recorded with its reason.)
2. **A failure names what the owner lost.** "You cannot attach a file — the attach
   control is missing from the composer", not "expected 200, got 500". The
   owner-facing sentence is the asserted VALUE, so it lands in any runner's diff,
   and a healthy run prints nothing at all.

**Where it runs, and why there.** In CI, in the ordinary sharded suite — no
workflow change, no schedule, no notifier. All four incidents above were
*regressions introduced by a merge*, so the moment that matters is before the
merge, and a red required check is already the signal the owner watches. It is
also silent when healthy by construction, which a periodic "everything is fine"
post is not. Deliberately NOT a runtime monitor: there is no network, no model
and no clock anywhere in it, which is exactly why a red can be believed.

**Mutation-tested** (per the "prove the gate still fails on a real violation"
rule).

*Web + server:* reintroducing the wide-branch `usage` omission reds the wide
layout AND the parity check; renaming the attach control reds both layouts;
removing `statusChatCommandFilter` / `tridentCodeChatCommandFilter` from the
composer's chain names `/status` and `/code` as lost; adding an unaccounted-for
filter factory reds the completeness gate.

*Mobile:* deleting `{...voiceHandlers}` from `ChatSyncSurface` — the LITERAL
omission that shipped — reds both platforms with *"You cannot record a voice
message…"* and *"You cannot use hold-to-talk…"*. Dropping ONE of the five voice
callbacks (`onVoiceHoldMove`) reds hold-to-talk alone, so the gate catches a
partial forget, not just an all-or-nothing one. Dropping
`pickAttachments` reds attach; dropping `usage=` from the narrow tab band reds
the meter. On the completeness side: adding an unprobed optional callback to
`InputComposerProps` reds it by name; removing the `Platform.OS === 'web' &&`
guard from the shell's width branch reds it with the file and line; renaming the
props interface trips the "the scan is alive" assertion rather than passing
vacuously.

**What it does NOT cover — the honest list.**

- **Anything time-based or media-based.** The voice note that looped forever is a
  playback-behaviour bug, not a reachability one; nothing here would see it. Nor
  would anything here notice that a clip contains no audio, that it sounds wrong,
  or that playback drifts — the harness's microphone and player are counting
  stubs with no clock and no samples in them. That is deliberate: those are
  behaviour questions, they belong to the voice-playback suites next door, and
  half-covering them here would put a timing assertion inside the one gate that
  has to stay believable when it goes red.
- **The mobile app's remaining surfaces.** The mobile gate probes the project
  shell and the chat surface — the owner's daily path. Admin, onboarding, the
  docs/work/launcher tab bodies, the backups sub-route and the settings screens
  have no inventory entries, so a control can still die inside one of them
  unnoticed.
- **A real device.** The mobile gate is react-native-web under happy-dom: real
  components, real handlers, real state — but not Hermes, not a native gesture
  recogniser, not a real microphone, not a native layout. Everything visual, and
  anything the native binary owns, stays UNVERIFIED until it runs on a phone
  (bounds: `app/__tests__/support/native-harness.ts`).
- **CSS.** happy-dom renders the tree React produced, not a layout. An affordance
  that renders and is then covered, clipped or `display:none`d by a stylesheet
  still reads as reachable. Only a real browser closes that, and the one browser
  script in the repo (`tests/e2e-browser/onboarding_walkthrough.py`) is orphaned:
  not discovered by `scripts/run-tests.sh` (it globs `.test.*`/`.spec.*` only, so
  a `.py` file is invisible), not referenced by CI, and it prints `E2E SKIP` and
  **exits 0** when no server answers — so it can prove nothing indefinitely
  without anyone noticing.
- **`/remind` and `/cal`.** Excluded with reasons in
  `open/__tests__/reachability-inventory.ts`: both claim conditionally (on a parse
  succeeding, on an integration being connected), so a red would be ambiguous
  between "unwired" and "not applicable on this box". A gate that fires on a
  healthy install teaches everyone to ignore it, and this repo has already lived
  through a permanently-red check hiding a second dead one (#384/#388).
- **Runtime and post-deploy breaks.** This is a pre-merge gate. It says nothing
  about the running instance. The natural home for that is a seventh watchdog
  detector — every existing detector (`watchdog/detectors.ts`) watches process
  liveness, none exercises product functionality — reusing the notifier that
  already broadcasts supervisor alerts to the chat surface. Not built.

## Route-slot coverage gate — is the declared HTTP surface actually served? (`open/__tests__/route-slot-coverage*`)

**The same class of bug, one layer down.** The reachability gate above proves the
owner can still reach a working part. This one proves the part is SERVED at all.
`gateway/http/route-slots.ts` declares the whole HTTP surface, but a `RouteSlot`
is live only when a real composer sets its `CompositionInput` field; when none
does, the ladder falls through and the caller gets the default 404 —
indistinguishable from a typo'd path. That is how a complete mobile reminders UI
(`app/lib/reminders-client.ts`, `app/app/projects/[id]/reminders.tsx`) came to
ship against endpoints that 404, and it is the same "built at both ends, never
connected" shape as the persona-gen and `/code` incidents.

**Why it is a runtime check and not a grep.** The obvious gate is a lexical scan
of the composers for `<key>:`. It was tried first and produced false positives two
ways: `open/composer.ts:4565-4566` assigns two surfaces by object SHORTHAND (no
colon), and `cores_surface` is never written in a composer at all — it is filled
in after the graph composes, by `gateway/composition/wire-cores-surfaces.ts:49`.
Three served surfaces reported dead. A gate with false positives is worse than no
gate here specifically: #384/#388 already showed a tolerated red training everyone
to merge past it and hiding a second, completely dead check for days. So
`open/__tests__/route-slot-coverage.test.ts` boots the REAL Open composition, runs
the real `composeProductionGraph`, and reads which slots the resulting composition
carries. Shorthand and post-compose mutation are both seen for free. ~10s, one
boot, no network and no model.

**It is a ratchet with written reasons.** 16 of the 39 declared slots are unserved
today, so a blanket assert would be permanently red. `route-slot-coverage-inventory.ts`
carries the served baseline (which may only grow) and every absence WITH its
reason and what the owner is missing — `why` plus `costs`, because a bare list of
names rots into permission. The test fails on a new absence, on an unclassified
slot, and on an allowlist line that has stopped being true.
`scripts/ci/route-slot-ratchet-guard.sh` (layering job, needs full history) is the
half the test cannot be: the test reads its own baseline, so it cannot see a rung
being MOVED into the allowlist, which deletes the assertion rather than failing
it. Deleting a slot outright stays legal — the comparator is handed the live
declared set so a real deletion is not a false alarm.

**Mutation-tested** in both directions: removing `app_tasks_surface` (plain
assignment), `chat_history_surface` (shorthand), or the `cores_surface`
post-compose assignment each turns the gate red naming the lost surface; the 16
legitimate absences keep it green; demoting a rung into the allowlist fails the
ratchet guard, promoting one passes it.

**What it does NOT cover.** It answers "is the slot populated", not "does the
handler behave". It reads the composition rather than issuing requests, so a
surface that is mounted but disclaims every path still reads as served. And it
says nothing about which of the 16 absences should be fixed — each needs a
wire-or-delete decision (Focus, for one, is dead at both ends: nothing navigates
to `app/app/focus.tsx`, so mounting its backend would serve an unreachable page).

## Mobile device-shaped test harness — `app/__tests__/support/native-harness.ts`

**What it is for.** Until 2026-07-29 the app suite could not mount a single React
Native component; ~1,200 app tests covered pure helpers and HTTP clients only, so
the entire React WIRING layer was untested. That is how mobile chat shipped
green-on-everything while having **never delivered one message from a phone**
(`crypto.randomUUID()` in `SendQueue` on a runtime with no `crypto` global — see
`docs/as-built/2026-07-29-mobile-send-webcrypto-and-keyboard-inset.md`). Unit
tests, typecheck and lint cannot see a keyboard covering an input, a send that
never fires, or a loading state that is never left. This harness can see two of
those three.

**How it works.** `installNativeHarness()` at the top of a test file, then load the
code under test with `await import(...)` (the aliases only apply to imports
evaluated after the call, so they must be dynamic). It registers happy-dom,
installs a Bun plugin that aliases `react-native` → `react-native-web` plus inert
stubs for the expo modules with no JS implementation, shims `globalThis.expo`, and
fakes a viewport rect (happy-dom reports 0×0, which would make layout assertions
vacuously green).

**A correction worth keeping, because the wrong version was written down once.**
The rect the harness fakes (`HARNESS_SCREEN_WIDTH` = 393) feeds
`getBoundingClientRect` and NOTHING ELSE — it never reaches `Dimensions` or
`useWindowDimensions`, so it does not "pin the harness to one screen width". What
a width-dependent branch actually reads is `useWindowDimensions()`, which
react-native-web derives from `document.documentElement.clientWidth`; happy-dom
reports **0**, which is why an untouched harness renders every narrow branch.
Widening it is already solved by `withWideViewport()` in
`app/__tests__/usage-meter.test.tsx`, which sets `clientWidth`/`clientHeight` +
the visual viewport and fires `resize`, with a guard test asserting
`Dimensions.get('window').width > BREAKPOINTS.narrow_max` so the block cannot go
vacuous. Reach for that rather than inventing a second mechanism.

Three capabilities carry most of the value:

- **`withoutWebCrypto()`** — deletes `globalThis.crypto`, reproducing the device
  runtime. Bun HAS WebCrypto, and that single difference is the entire reason the
  send bug was invisible to every other gate.
- **Settable `Platform.OS`** (`setHarnessPlatform('ios')`) — `ios`-only branches
  actually execute instead of falling to the web path.
- **A driveable `Keyboard` event bus** (in `support/stubs/react-native.ts`) —
  react-native-web's `Keyboard` never emits, so subscribing to the real one would
  make every keyboard assertion pass for no reason.
- **Settable safe-area insets** (`support/stubs/safe-area-context.ts`,
  `setHarnessSafeAreaInsets`) — the real `useSafeAreaInsets` throws without the
  native provider `expo-router` installs, and it defaults to an iPhone shape
  (59pt top / 34pt bottom) rather than zero, because a zero default would make an
  inset regression invisible. The composer must clear the home indicator with the
  keyboard DOWN and must not add it again with the keyboard up; only a non-zero
  driveable inset can assert both.

`support/mount.tsx` supplies the interaction vocabulary: `type()` (through the
prototype value setter, so React sees it), `press(accessibilityLabel)` — which
THROWS when the control is absent or disabled, so an unreachable button fails the
test — and `FakeChatSocket`, which records every outbound frame.

**IT RUNS IN ITS OWN PROCESS — the device-harness isolation lane.** Registering a
DOM and aliasing `react-native` are process-global acts that cannot coexist with the
rest of the suite: `landing`'s happy-dom tests call `GlobalRegistrator.register()`
unconditionally and it THROWS when a DOM already exists, several app tests own the
`react-native` specifier with process-global `mock.module` fakes, and a registered
DOM cannot be unregistered without breaking the harness files still queued in that
process. Mixed into a general chunk this cost **68 failures across three CI shards**
in unrelated packages. `scripts/run-tests.sh` therefore runs every file mentioning
`installNativeHarness` in a dedicated lane, exactly like the PGLite-WASM quarantine
lane; membership is content-derived so a new harness suite is isolated automatically,
and lane files still count toward the coverage audit. `NEUTRON_TEST_NO_DEVICE_LANE=1`
folds them back in and is expected to fail. A bare single-file `bun test` is always
safe. Details: `docs/testing-runner.md`.

**BELT AND BRACES INSIDE THE LANE.** The lane makes collisions impossible; these two
rules make a harness file well-behaved anyway, which is what keeps a single-file run
and any future co-tenant honest:

1. `registerDomKeepingBunNetworking()` captures Bun's `fetch`/`Response`/`Request`/
   `WebSocket`/`URL`/… before `GlobalRegistrator.register()` and restores them
   straight after. The harness needs the DOM, not happy-dom's network stack; a
   gateway test booting a real `Bun.serve` otherwise fails Bun's
   `Expected a Response object` check.
2. **Every harness suite MUST call `resetHarnessGlobals()` in `afterAll`** — it
   restores `getBoundingClientRect`, the real `WebSocket` (a leftover
   `FakeChatSocket` hangs the next file's real WS test until timeout) and
   `Platform.OS`.

The DOM registration itself is deliberately not undone: unregistering after
react-native-web has captured browser globals would break harness files still to
run in the same process.

**It does not contest the `react-native` specifier.** Four existing app tests own
it with process-global `mock.module('react-native', () => ({ View, Text, … }))`
fakes, and Bun runs many test files per process, so whichever loads first breaks
any later real component tree on the first omitted export. The harness rewrites
`from 'react-native'` inside the app's own sources to its stub instead, which makes
it order-independent. `native-harness-selfcheck.test.tsx` asserts the harness's own
preconditions so a degraded harness fails loudly rather than silently turning the
device suites into no-ops.

**THE REWRITE'S BLIND SPOT — the stubs directory (found 2026-07-30).** That rewrite
is scoped to `app/{app,components,lib,features}`, so it does NOT cover
`support/stubs/`. `stubs/flash-list.tsx` imported `View` from the `react-native`
SPECIFIER and therefore asked the registry — receiving whichever three-export fake
had loaded first. Its `View` renders `null`, so EVERY transcript row silently
vanished from a mounted chat test that happened to share a chunk with
`docs-panes-render.test.ts`: six order-dependent failures with no relationship to
the code under test. Stubs now import their siblings by path. The residual hazard
that path cannot fix is an app-MODULE mock — `docs-panes-render.test.ts` also
registers `mock.module('../lib/markdown-render', …)`, so any agent bubble's body
renders empty in a co-tenant chunk; a mounted assertion on agent body TEXT is
therefore order-dependent by construction, and the chat suites assert on rows and
on user-message text instead.

**HONEST BOUNDARY — it is not a device.** No native layout, no real keyboard, no
gestures, no Hermes semantics, nothing in the native binary. It proves WIRING and
ARITHMETIC. Anything visual ("the composer is visible above the keyboard") stays a
DEVICE claim and must be confirmed on a handset before being called done.

Suites built on it: `mobile-chat-send-on-device.test.tsx` (submit → outbound frame
+ local bubble, with WebCrypto removed), `chat-keyboard-avoidance.test.tsx`, and
`imessage-chat-ux.test.tsx` (the four iMessage defects: the composer clearing both
the keyboard and the home indicator, the sender-run bubble rhythm, the activity
inspector's reachability, and the cold-start ack rendering as a transient pill
instead of a durable message).
