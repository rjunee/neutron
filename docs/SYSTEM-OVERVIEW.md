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
> - **Favicon = the ⚛ atom mark.** `landing/favicon.svg` now reproduces the
>   `AtomMark` geometry from `ChatApp.tsx` (center dot + 3 rotated orbit ellipses)
>   in a FIXED accent hex (`#007aff` — a favicon can't read page CSS vars), so the
>   browser tab matches the rail-header icon.
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

Tier 1 free Core for Instagram + X/Twitter scraping via Apify (Vajra parity
gap #6 — a direct port of `~/vajra/scripts/ig-scrape.sh` + `tx-scrape.sh`).
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
conversations). Agent-native parity: the same backend powers the `/scrape <url>
[mode] [--thread]` chat command (`createScrapingChatCommandFilter`), which
auto-detects IG vs X from the pasted URL. The production wiring helper
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
live) via `mountCoresScribeFanOut(...)`, which composes both schedulers using the
built factories, threads the binding, starts them, and registers a drain+teardown
`stop()` against `realmode_cleanups`. The binding is fire-and-forget (a failed
extraction never throws into a Core's brief/triage path) and exposes `idle()` for
clean shutdown draining. Each scheduler owns its own self-tick — **no duplicate
poller, no extra timer/fetch** beyond the Cores' own cadence. Until a
Google-OAuth-backed calendar/gmail client is connected, the in-memory fallback
clients yield an empty calendar/inbox so the schedulers run harmlessly; the
fan-out goes live with no further wiring the moment a real client is supplied.
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
  `buildLandingStack` → `buildWebChatBridge`. The web-chat bridge invokes the
  filter at the top of the `user_message` handler and, when a Core claims the
  command, ships the Core's reply as an `agent_message` and short-circuits both
  the live-agent turn and the onboarding engine — mirroring the Expo
  `createAppWsSurface` seam (`gateway/http/app-ws-surface.ts`). Before this the
  Open web chat had no slash-command interception at all; a typed `/cal` fell
  through to the LLM. Each Core's MCP tools and its chat-command filter share **one
  backend instance** (the pre-built `calendarClient` seam, one
  `EmailProjectCacheResolver`, the Research `project_backend`) — agent-native
  parity.
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

## Native-MCP tool transport (P0-1) — how the spawned agent invokes tools

The live chat agent is a spawned interactive `claude` REPL driven over the
dev-channel (`runtime/adapters/claude-code/persistent/`). It reaches the
gateway's in-process tool surface — Cores (`/cal` `/email` `/remind`
`/research`), `doc_search` / `doc_read`, `message_search`, `gbrain_search`
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
  history-import REPL (`cc-import-*`) and the Trident build / fire REPLs
  (`cc-trident-*` / `cc-trident-fire-*`) leave it off, so a prompt-injection in
  untrusted content can never reach a Core tool. The bridge's MCP namespace is
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

### Native SKILL.md discovery for the agent (P1-5)

The live agent discovers + invokes Claude Code **skills** natively — the same
built-in mechanism Vajra's `~/.claude/skills` rides on. At composer build,
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

## Tab resolver (WAVE 3 tabbed shell) — `tabs/` + `gateway/http/app-tabs-surface.ts`

The project (and global) tab set is resolved **engine-side** so both clients
(mobile RN + web React) consume one source of truth instead of hardcoding
their tabs. `tabs/registry.ts` exposes a `TabDescriptor` (`key`, `label`,
`scope: 'project'|'global'`, `source: 'builtin'|'core'`, `order`,
`mount: { kind: 'builtin'|'webview', target }`) and a
`resolveTabs(scope, cores)` resolver. **BUILTIN descriptors** — Chat /
**Work** (`work_board`, label "Work") / Documents per-project, Admin global — are
unioned with **CORE-contributed tabs** (PR-2): the `project_tab` surfaces of installed
Cores, shaped as `source:'core'`, `key:'core:<slug>'`,
`mount:{kind:'webview', target}` and sorted AFTER the builtins. The registry
stays **pure** (no DB / no package loading) — the HTTP layer resolves which
Cores are installed and passes a `CoreTabContribution[]` in.

> **Tasks is NOT a builtin tab** (Ryan directive, 2026-06-30). The `tasks`
> `BUILTIN_TABS` entry + the engine web tasks-tab UI (`TasksTab.tsx`,
> `tasks-client.ts`) were removed; Tasks returns in WAVE 3 as a **Core-contributed
> webview tab** through the same `CoreTabContribution` union. Per-project builtins
> are now **Chat / Plan / Documents** (orders 0/5/10).

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
native expo-router leaf (`mount.target` = `chat`/`workboard`/`docs`); **Core**
(`mount.kind:'webview'`) descriptors route to the generic
`app/app/projects/[id]/cores/[slug].tsx` webview (inline `<iframe>` on web,
system browser via `expo-web-browser` on native — no `react-native-webview`
dep). The legacy `PROJECT_TABS` const survives ONLY as the pre-fetch loading
default (and the on-error fallback) — not a flag-gated path. Consequence: the
registry's project builtins are Chat/Plan/Documents, so the old **Apps
(launcher)** + **Reminders** + **Tasks** tabs are no longer top-level mobile tabs
once the fetch resolves (their routes remain, reachable by deep-link); re-adding a
builtin is a `BUILTIN_TABS` change in `tabs/registry.ts`. The web shell
consumption is PR-4 (reworked 2026-06-30 — see below).

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

### Web client consumption (WAVE 3 PR-4)

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
>    `fix-round-N`→reviewing, `argus-approved`→merging). CRITICALLY, the durable
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
>    (`gateway/realmode-composer/operating-doctrine.ts`) now REQUIRES a Work Board
>    card for EVERY build — inline OR trident, any project — so no build is invisible.
> 5. **Underspecified builds ask in chat.** The ▶ route on an `underspecified`
>    rejection posts a short clarifying question to chat (`open/composer.ts`
>    `buildClarifyPoster`) and returns 200 (`work-board-surface.ts`) — never the raw
>    internal guard text into the work pane.

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

## Per-project Settings tab + credential system (`project-credentials/`, FOUNDATION)

Each project's tab set is Chat / Plan / Documents / **Settings**. The Settings
tab is a registry builtin (`tabs/registry.ts`, `key:'settings'`, `order:15`,
`mount.target:'settings'`) — both clients (web `landing/chat-react/SettingsTab.tsx`
via `ProjectShell.tsx`'s `TabContent`; mobile `app/app/projects/[id]/settings.tsx`)
render it from the ONE engine registry, never hardcoded. It hosts the
credentials UI, project rename + **emoji edit** (a real editable control since
the rail-redesign sprint — PATCH `{ emoji }` to the settings surface, mirroring
the name rename), and a display-only, M2-gated collaborators scaffold.

**Credential model.** A credential is a static, long-lived service token (Meta
Ads, Google Ads, Apify, …) set at **per-project** or **global** scope.
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
(`gateway/http/project-credentials-surface.ts`) owns
`/api/app/projects/<id>/credentials[/<service>]` (GET/POST/DELETE), wired into
`open/composer.ts` → `composition.ts` → `compose.ts` ahead of `appProjects`
(mirrors work-board precedence). The same canonical `ProjectCredentialStore`
backs the resolver AND the agent awareness: a per-turn `<available_services>`
DATA block (`project-credentials/fragment.ts`), keyed on the real per-turn
`project_id` (`LiveAgentTurnRequest.project_id`, parsed from the topic), spliced
by `gateway/realmode-composer/build-live-agent-turn.ts` exactly like the Work
Board block — so the agent knows which external services it can use in THIS
project and gracefully refuses the rest, and switching projects flips
availability within one turn. Wiring the existing Cores to CALL the resolver is
a named follow-up (needs per-call `project_id` threaded into each Core's token
provider — the deferred Phase-3 Cores rework).

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
  fragment (`gateway/realmode-composer/operating-doctrine.ts:BUILD_ROUTING_DOCTRINE`,
  spliced every turn) + the `work_board_dispatch_build` tool description: SIMPLE
  work (single file, quick script, small self-contained edit) is built INLINE with
  the agent's own Read/Write/Edit tools; COMPLEX work (multi-file, a real project or
  shared code, warrants review, large/risky) is routed to trident — the agent adds a
  Plan item (`work_board_add`) then calls `work_board_dispatch_build` bound to it,
  and TELLS the owner it is routing to trident and why. The tool is already on the
  live agent's surface (gated on the same Anthropic credential pool as the loop), so
  the owner never types a command — the agent decides.

See `docs/plans/2026-06-29-001-feat-work-board-master-plan.md` (§11 Phase 3/4).

## Create Project affordance — project rail + create-project capability

On a fresh install a skip-import owner had **no user-initiated way to create a
project** — projects only materialized at onboarding finalize, and reaching one
otherwise required the onboarding gap-fill quota (≥3 projects). The Create
Project affordance closes that: a button pinned at the **bottom** of the project
rail (rail order: **General → projects → Create Project**), plus a backend
create capability and an agent tool, so the owner (or the agent) can spin up a
fresh project + its tabs (Chat / Work Board / Documents) on demand.

**One code path (`gateway/realmode-composer/project-create.ts`).** The shared
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

**Mobile rail** (`app/app/projects/index.tsx` + `app/lib/projects.ts`
`createProject` / `projects-client.ts` `create`). A bottom-pinned `+ Create
Project` bar reveals an inline name input → `POST /api/app/projects` →
`router.push('/projects/<id>')`. No migration (the `projects` table already
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
  uses the fixed delta. `time_zone` defaults to the host zone ("9am" = 9am
  local). A corrupt cron fires once then retires so it can't wedge the loop.
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
preserve a reminder's cadence across the atomic cancel+create.

## Proactive messaging — daily brief + idle-nudge sweep (`gateway/proactive/`)

The owner-facing proactive layer (Vajra parity). Both halves were built + tested
early but stayed DEAD until P1-4 because they register only when
`tasks.proactive` is set — and the Open composer never set it. The daily brief
now ships ON (no feature flag); `open/composer.ts` wires `tasks.proactive`.

- **Daily morning brief** (`morning-brief.ts`) — **ACTIVE.** Once per owner-local
  day at/after `brief_hour`, composes from live context (focus/task queue,
  optional calendar / entity / project sources — each gathered behind its own
  try/catch) and posts to the owner's General topic. **Owner-local day** is
  computed from the host's actual timezone, not a hardcoded Pacific default:
  `open/composer.ts` resolves it once via `resolveLocalTimezone` (`local-timezone.ts`
  — `process.env.TZ` override → the runtime's `Intl` zone → a defensive floor) and
  threads it through `tasks.proactive.timezone`. A non-Pacific host therefore gets
  the brief at its real local hour (Ryan: "Detect local computer time not hardcode pt").
  **LLM composition (Vajra
  parity):** `buildLlmBriefComposer` routes the resolved `BriefContext` through
  the warm `cc-llm` substrate (grounded in exactly the resolved evidence, no
  fabrication); the pure `composeMorningBrief` template is the deterministic
  fallback when the LLM throws/empties, so the brief is never lost. Same-day
  idempotency lives in `proactive_brief_log`.
- **Durable web sink** (`button-store-sink.ts`). Open's topics are `app_socket`
  and proactive posts fire from a timer, so they route through
  `buildButtonStoreProactiveSink` — an `OutboundSink` that persists an INERT,
  already-resolved agent history turn (`ButtonStore.persistInertAgentTurn`, so a
  passive scheduled post never becomes the topic's active prompt) + best-effort
  live-push, the same durable path fired reminders use — NOT the core
  `ChannelRouter`'s live-only `AppWsAdapter` (which would drop a post with no
  open socket). `tasks.proactive.sink` overrides the router; absent → router
  (Telegram instances).
- **Idle-nudge sweep** (`idle-nudge-sweep.ts`) — code + gate complete; sweep cron
  **not yet auto-enabled** in Open. Per tick it would consider each idle
  project-bound topic with a fresh ranker pick (`current_focus_pick`) and post
  ONE highest-leverage next action through three gates: idle threshold (default
  4h) → dedupe (never re-nudge the same task until the owner returns) → the
  **dual-rating ≥7 quality gate** (`evaluateQualityGate` + the `rateNudge` LLM
  seam, `buildLlmNudgeRater`): a candidate is rated 1–10 on leverage + gratitude
  and only posts when BOTH ≥7; a null/abstain rating skips (`low_quality`).
  Without the gate the sweep would nudge every idle topic. The composer does NOT
  yet set `listIdleTopics` (so the sweep cron does not register): a correct
  enumeration needs a user-turn-only activity watermark (`last_created_at` counts
  agent rows, incl. the nudge's own, which would defeat dedupe) + both the
  `web:` and `app:` topic namespaces. The `rateNudge` gate is wired and ready for
  when that enumeration lands.

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

- **Agent memory RECALL (P0-2) — `gbrain_search` (`gbrain-memory/agent-tool.ts`).**
  The scribe WRITES entities + facts to this store on every turn; `gbrain_search`
  is the matching READ tool the spawned agent calls natively as
  `mcp__neutron__gbrain_search` (rides the P0-1 bridge). It is backed by the SAME
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
  Wired when `open/composer.ts` supplies `MiscCompositionInput.gbrain_search.store`
  (always, since `buildGBrainMemory` always builds the store).

- **Init guard — the brain is `gbrain init`'d before the first `serve` (ND1).**
  `gbrain serve` exits with "No brain configured" against an uninitialized
  brain, so before the dogfood fix prod served an un-init'd brain → every MCP op
  failed `Connection closed` → `gbrain_search` / scribe-write / admin Memory
  silently no-op'd (recall was masked by Claude Code file-memory). The fix:
  `gbrain-memory/ensure-brain-init.ts#ensureBrainInitialized` runs an idempotent
  `gbrain init --pglite --non-interactive` (skip-embed-check) the FIRST time the
  `GBrainStdioMcpClient` connects (`opts.ensureInitialized`, wired by
  `buildGBrainMemory`). Idempotent (no-op once `<GBRAIN_HOME>/.gbrain/config.json`
  exists) and fail-soft (a missing binary / failed init returns a status, never
  throws → the existing latched degrade-path). The brain is created
  **embeddings-ready** (an OpenAI `text-embedding-3-large` 3072-dim column) even
  with no key — so the default still computes NO embeddings (verified: `serve`
  answers `put_page` + keyword `search` with no key) yet a later key upgrades in
  place with no schema rebuild (a `--no-embedding` 1280-dim column can't — OpenAI
  rejects 1280-dim vectors).
- **Default — keyword + graph, NO embeddings.** Memory search runs on GBrain's
  BM25 keyword index + the typed-edge graph. No embeddings are computed without a
  key; provisioning and search need no external embedder. This is the shipped
  default.
- **Embeddings flip on with an OpenAI key — `gbrain-memory/embedder-config.ts`.**
  Two triggers resolve an embedder (`resolveEffectiveEmbedder` in
  `build-gbrain-memory.ts`):
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
     and `buildGBrainMemory` calls it at the first memory op: the lazily-resolved
     embedder env (`GBRAIN_EMBEDDING_*` + `OPENAI_API_KEY`) is merged into the
     `gbrain serve` child via `GBrainStdioMcpClientOptions.resolveDynamicEnv`, and
     `ensureBrainInitialized` inits against that same embedder and backfills
     pre-key pages once via `gbrain embed --stale`. So a stored key alone flips
     GBrain to semantic embeddings on the next turn — no env flag, no restart —
     exactly as the onboarding offer ("flips on your next turn") promises. The key
     is memoized at first spawn so the init guard + serve child agree on the
     embedder selected then; `null`/absent → keyword + graph, byte-for-byte
     unchanged.
  2. **The operator env opt-in (`NEUTRON_EMBEDDINGS`) — unchanged.**
     `resolveEmbedderConfig(env)`: `openai` (3072d), `ollama` (768d,
     `OLLAMA_BASE_URL`), `auto`, or `off`/unset. A bare `OPENAI_API_KEY` (consumed
     by the GPT LLM adapter) does **not** enable embeddings on its own.

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
  cases in `gateway/realmode-composer/__tests__/build-gbrain-memory.test.ts`.

- **Auto-upgrade + doctor (`gbrain-memory/gbrain-doctor.ts`).** `ensure_gbrain`
  pins a point-in-time snapshot of an UNPINNED default branch with no upgrade
  path and no health verification. The doctor — modeled on Vajra's
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
  becomes resolvable by `gateway/realmode-composer/resolve-llm-credentials.ts`
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
> `/api/cores/api-keys/<label>`) surfaces the global `admin` tab in the web
> ProjectShell. Verified in a real headless Chromium (system Playwright):
> `tests/e2e-browser/onboarding_walkthrough.py` (CI-skippable) — `/chat` → React →
> fresh onboarding renders + advances over the single socket; Documents + Admin
> tabs render.

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
- **SERVER-GATED verdict provenance:** a merge-eligible `APPROVE` is honoured ONLY
  when the Argus phase's OWN recorded `inner_checkpoint = 'argus-approved'` (written
  by the synthesis-phase Bash step) backs it — a self-asserted `APPROVE` in the
  result line with no recorded provenance is REJECTED to `failed`, never merged.
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
- **Worktree cleanup ENFORCED (D-1/C3):** the workflow's `finally{}` scans `git
  worktree list` for the deterministic `trident/<slug>` branch and removes it on
  every path (independent of Forge's return value — the harness only auto-cleans
  an UNCHANGED worktree, and a Forge build always commits). `merge.ts` adds the
  OUTER backstop (best-effort `git worktree remove --force` + `prune` after a
  landed merge), flipping the old "NO `git worktree remove`" lock.

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
  maps to `failed`, never `fired` (Open analog of Vajra's fleet "paused vs
  finished" reap fix #160). The inlined Forge contract still hard-rules cross-model
  review as **best-effort, after the PR is open, never a turn-yielding hang
  point** (Open analog of Vajra PR #164). See
  `docs/research/vajra-neutron-fix-reconciliation-2026-06-24.md`.
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
lifecycle/manifest, and the Managed graph composer. See `AS-BUILT.md`.

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
  never read a >3000-line diff in one shot). **Prompt single-source (P1-3):**
  the Forge/Argus contract bodies LIVE on disk at `prompts/forge.md` /
  `prompts/argus.md` and are read fresh per render via `@neutronai/prompts`
  `loadPrompt` (`loadForgeTemplate()` / `loadArgusTemplate()`), so the files
  the team edits ARE what the spawned agent receives (no inline-vs-file drift).
  All four dispatchable roles resolve their prompt from disk BY TYPE: forge/argus
  as the user-message contract (`trident/prompts.ts`), atlas/sentinel as the
  system persona (`trident/agent-prompts.ts`, via `dispatchAgent`). `trident/merge.ts` fills the
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

  - **`stuck` keys off JSONL turn-progress, not the in-memory clock** (ported
    from Vajra `stuck-turn-watchdog.ts`, incident 2026-04-21: a CC turn wedged
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

## Agent dispatch family — named specialists + ad-hoc spawn (`agent-dispatch/`)

Vajra dispatches a small family of background specialist agents (and ad-hoc
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
  the backstop); and the rest of Vajra's persona set + cross-topic dispatch.

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

**The routing gate (the live seam).** `gateway/http/chat-bridge.ts`
`handleProjectTopicInbound` reads the per-project mode (injected
`resolveEngagementMode`, wired in `build-landing-stack.ts` off this instance's
`projects` table, read-only + failure-safe → `all_messages`). In `tag_gated` a
non-mention post **persists to the shared transcript** (`persistProjectUserTurnOnly`)
and clears the optimistic typing dots with a no-render `agent_ack` — **no agent
turn, no typing indicator**. The transcript ALWAYS persists in both modes; only
the agent-turn TRIGGER is gated. A tagged TASK (in `tag_gated`) routes to the
optional `delegateDispatch` hook (the gap#3 `agent-dispatch/` family) which spawns
a background subagent that reports back into the thread; a tagged question is
answered inline.

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
`PersonaPromptLoader` (`gateway/realmode-composer/persona-loader.ts`) reads every
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
(`child.write`). Vajra's tmux era accreted ~21 detectors that watched the pane
for a state signature and reacted with a keystroke; porting those to Neutron
needs three reusable primitives first. This PR ships the substrate (detectors
themselves land in follow-on P0/P1 PRs). See
`docs/research/vajra-terminal-detection-keystroke-port-2026-06-25.md`.

- **F1 — public ring-read accessor (`pty-ring.ts`).** `PtyRing` replaces the
  old debug-gated 16 KB closure (`debugRing()`, `NEUTRON_REPL_DEBUG`-only) with
  a widened 64 KB rolling buffer + `getRecentOutput({ bottomN?, normalize? })`:
  line-addressable (bottom-N newline-delimited lines, à la `capture-pane -S`) and
  optionally `normalizePtyText`-collapsed so Ink per-word-cursor ANSI doesn't
  break contiguous-signature matching. Exposed on `ReplSession.getRecentOutput`.
  The 64 KB widening (from 16 KB) is so bottom-N guards can see content rendered
  *below* the footer (the 2026-06-16 Robobuddha status-panel miss).
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
  hook (GENERALIZED — not a competing scan loop). Four Vajra invariants are baked
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

## Wedged-interactive-prompt detect + recover (P0) — `wedged-prompt-detector.ts`

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
  2026-06-16 Robobuddha status-panel-below-footer miss; the `^❯` anchor rejects
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
  days (Vajra PR #132 r1) — the bottom-N window lets idle whitespace push the
  picker past the threshold so the detector correctly stops. A 60s `debounceMs`
  floor + the framework's before-await latch stamp make `3`+enter fire-once. The
  F3 doc-quote guard keeps a quoted/backtick mention of the command from firing.
  Vajra's viewport-pre-check-gates-recapture lesson (Argus #132 r3) is obviated:
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
  REPL. The hard-won Vajra lesson is **ESCAPE-THEN-RECOVER, never blind-answer**: a
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
  — the Neutron analog of Vajra's `findLatestSessionForTopic` — which scans
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
keys off an *unanswered real-user turn* going stale, and the wedge-detector keys
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
Vajra's `isChannelMcpUnwired`). Reproduced **live under the real Bun PTY harness**
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
- **Bounded respawn (`channel-wedge-respawn.ts`, invariant §6).** Unchanged: a
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

## Disk-JSONL recovery + restart-rate crash-loop guard (#20) — `disk-recovery.ts` + `restart-rate.ts`

The cross-restart recovery substrate (master-table row #20). It encodes one
hard-won lesson: **disk JSONL is the source of truth; the in-memory
registry/timer is just an index.** Incident (Nova/Vajra "pristine" 2026-05-21):
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
- **Disk-JSONL resumability classifier (NEW, `disk-recovery.ts`).** When the
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
  (the pristine 118s double-restart). The warning is **edge-triggered + latched**
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
  infinite restart loop (Vajra 2026-04-16: the "tax topic" hit 11.8 MB).
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
    gateway that DOES wire a pressable Reset/Compact button (Vajra's Telegram
    inline keyboard) simply omits `isIdle` and stays surface-only. Vajra's own
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
in `docs/research/vajra-terminal-detection-keystroke-port-2026-06-25.md`).

## Model-update watchdog + graceful upgrade (P3, port row #16) — `model-update-watchdog.ts`

Auto-detects when Anthropic ships a newer top-tier Claude model and gracefully
moves every warm session onto it — so the box never drifts on a stale model for
days (Vajra 2026-04-16: Opus 4.7 shipped overnight, the gateway sat on 4.6 for
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
  on 4.6 while 4.7 already shipped is detected on the first probe (Vajra's
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
  (`build-live-agent-turn.ts`, resolved inside the per-turn body), the LLM router
  default (`build-llm-router.ts`), the project-opening / project-doc / phase-spec
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
  blocking). The idle gate (`isSessionIdleForUpgrade`) requires ALL four Vajra
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
`docs/research/vajra-terminal-detection-keystroke-port-2026-06-25.md`.

## Stuck-typing reaper (port row #9) — VERIFIED-OBVIATED, no scraper

Vajra's #9 (`pane-scan-watchdog.ts decideStuckTypingAction` + `index.ts
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
`docs/research/vajra-terminal-detection-keystroke-port-2026-06-25.md` (was
PARTIAL/P2): the no-reply case is covered structurally and better; the mid-stream
sliver is bounded by the turn timeout + keepalive re-scan; no new code warranted.

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
- *Per-topic envelope routing (P1a, 2026-06-26).* The web client multiplexes
  every topic over ONE socket and runs a per-topic drop-guard: it only paints a
  message whose `topic_id` matches the focused topic (otherwise it routes to that
  topic's own view / hydrates on switch). So EVERY outbound web envelope stamps
  the destination `topic_id` — the live-agent reply + cold-start/failure bodies
  (`build-live-agent-turn.ts`), the wow `sendText`/`emitPrompt`
  (`build-wow-dispatcher.ts`), the recovered-reply replay
  (`recovered-reply-store.ts`), and the chat-bridge command/failure/`agent_ack`/
  `error`/slug-rename envelopes (`chat-bridge.ts`). Without it an async
  notification (a wow-moment, a reconnect-replayed recovered reply) painted into
  whatever topic was focused (cross-project bleed). The app-ws (Expo mobile)
  surface carries `project_id`/`message_id` on its own envelope shape instead.
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
until this — `docs/research/vajra-neutron-feature-parity-scan-2026-06-25.md` §2.R/§5.5).
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
- **Notifier.** Open is WS-native + single-owner, so the proposal `ProposalNotifier`
  logs (mirroring agent-dispatch's report sink); the persisted `skill_forge_proposals`
  row is the source of truth, surfaced on demand via `/skills list`.

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
