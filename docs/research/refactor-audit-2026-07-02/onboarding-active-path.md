# Onboarding active-path investigation — which flow runs, what "delete the other one" means

Date: 2026-07-02. Repos: /Users/ryan/repos/neutron-open @ main (d30280c), /Users/ryan/repos/neutron-managed @ main (20c850d, vendor @ f04b3f6).
All claims cite file:line and are VERIFIED against the working trees unless marked *inference*.

## Verdict (headline)

A fresh neutron-open install runs the **conversational Path-1 flow** — onboarding conducted by the
live Claude Code session over `/ws/app/chat` — and it does so **unconditionally**: no flag, no branch.
The `NEUTRON_ONBOARDING_CONVERSATIONAL` env var is already **collapsed** — nothing in production reads
it (`runtime/platform-adapter-local.ts:253-264` hard-pins `{enabled:true, phases:'all'}` and documents
"ONE path, no flag"). The "other one" — the InterviewEngine's per-turn conversational drive
(`engine.start`/`engine.advance`/`consumeChoice`/llm-router) — is **already caller-less dead code on
every live path**; deleting it is a code-removal exercise, not a behavior change. Managed hosted
onboarding spawns the vendored `open/server.ts` per tenant and therefore runs the SAME Path-1 flow —
**no cross-repo conflict**, with one pinned exception (`agent-name-suggester.ts`, see §4).

**The real topology (this determines how "delete the other one" parses):** the two modes are NOT
parallel engines, and Path-1 is NOT a router layered on the phase machine. They **share the durable
state layer** (`OnboardingStateStore` rows, the `phase.ts` enum used as crash-safe markers, the
required-fields vocabulary) but Path-1's conversation runs entirely OUTSIDE the engine. The engine
survives as exactly one live subsystem: the **history-import pipeline** (`notifyImportUpload` +
import-running cron + import prompt emission). So the deletion unit is "the conversational half of
the one engine + its satellites", not "a second engine".

---

## 1. The flag — who reads it, what a fresh install gets

- Parser: `runtime/onboarding-conversational-flag.ts:45-57` — **absent env → `{enabled:true, phases:'all'}`**
  (default-ON since the 2026-06-21 consolidation; opt-out tokens `0/false/off/none/""` disable; typos fail closed).
- **Superseded**: `runtime/platform-adapter-local.ts:253-264` — "Path 1 (onboarding-as-CC-session,
  2026-06-27) — the conversational flag is COLLAPSED … We hard-pin the accessor to always-on … and no
  longer read `NEUTRON_ONBOARDING_CONVERSATIONAL` — ONE path, no flag. `resolveOnboardingConversational`
  is retained only for back-compat callers/tests; nothing in production consults the env var now."
- Verified no production `process.env` read anywhere: the only remaining mentions are doc comments
  (`runtime/platform-adapter.ts:595`, flag file `:42`) — grep over all non-test `.ts` confirms.
- Installer: `.env.example` does not mention the var (only `NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET`, line 72);
  `install.sh`/`scripts/` never set it.
- Interface residue to sweep: `PlatformAdapter.getOnboardingConversational()` /
  `getOnboardingConversationalPhases()` (`runtime/platform-adapter.ts:600, :615`) and the engine's
  `shouldConsultRouter` gate (`onboarding/interview/engine.ts:7157` doc, gating cluster :3087-3305) —
  all dead because their only call path (`engine.advance` freeform) is dead (§2).

## 2. Fresh-install first-visit trace (verified end-to-end)

1. **GET `/` or `/chat`, no cookie** → `coldStartRedirect` mints the owner cookie + a one-shot local
   start token and 302s to `/chat?start=<token>` (`open/composer.ts:1460-1467`). The token is consumed
   **only at this HTTP cookie-mint gate** — "With the legacy `/ws/chat` onboarding socket deleted, the
   start token is now consumed ONLY at the HTTP `/chat?start=` cookie-mint gate" (`open/composer.ts:1185-1186`).
   ⚠️ The nearby comments "`/chat?start=<token>` → engine.start → first onboarding prompt"
   (`open/composer.ts:1450, :1456`) are **STALE** — no `engine.start` call exists in the composer
   (verified: the only engine method the composer invokes is `landing.engine.notifyImportUpload`, :1348).
2. **`/chat` serves the React shell** — `chat-react.html` + `/chat-react.js` is the ONLY web client;
   the vanilla `chat.html`/`chat.ts` surface and the `NEUTRON_WEB_CHAT_CLIENT` flag were deleted
   ("Ryan-locked: no feature flags, no dual code paths", `landing/server.ts:1158-1173`; the shell is
   REQUIRED — boot throws if missing).
3. **Client opens `/ws/app/chat`** (`gateway/http/app-ws-surface.ts:204`); on WS open the surface fires
   `on_session_open` (`app-ws-surface.ts:348-350`, contract :158-171 — note its doc comment saying the
   composer "calls `engine.start`" is also **stale**).
4. **Path-1 auto-start**: the composer's `on_session_open` (`open/composer.ts:3415-3507`) checks
   `isOnboardingActive` — "No state row = fresh install → onboarding" (`:2385-2391`) — and **seeds a
   synthetic turn into the live CC session** via `appWsChatTurn` (`:3476-3485`: "Greet them warmly …
   ask what they would like you to call them"). No engine involvement.
5. **Every subsequent turn**: typed text → `appWsReceiver.receive` → `appWsChatTurn`
   (`open/composer.ts:3283-3336`: "Path 1: ONE path … No `engine.advance`, no freeform router gate");
   button taps → `on_button_choice` → `appWsChatTurn` (`:3546-3580`: "No `engine.advance` branch").
6. **Field capture / completion**: a fire-and-forget post-turn extractor scribes the profile into the
   SAME `OnboardingStateStore` (`open/composer.ts:2615` → `onboarding/interview/post-turn-extractor.ts`);
   finalize (persona + project materialization + `completed` phase) runs via `buildOnboardingFinalize`
   (`open/composer.ts:2484-2530`).
7. **Import branch (the engine's one live job)**: a ZIP upload drives `landing.engine.notifyImportUpload`
   (`open/composer.ts:1338-1348`); the import-running cron is the ONLY interview cron Open registers
   (`open/composer.ts:3697` — `onboarding_resume_cron` is NOT passed; cf. `gateway/composition/build-core-modules.ts:577-620`);
   engine-emitted import prompts route through `appWsButtonPromptRouter.send`
   (`open/composer.ts:3147-3235`: "Path 1: the engine no longer drives the conversation. Its prompts on
   this socket are import-side only"); `import_analysis_presented` is consumed by the composer's
   import-completion watcher via a **direct state-store upsert** back to the conversational marker
   `work_interview_gap_fill` — not `engine.advance` (`open/composer.ts:2653-2699`).

### Why the engine's conversational drive is dead (the load-bearing verification)

The audit note "chat-bridge still drives the full engine for `web:` topics" is **out of date**. The
chat-bridge's conversational entry points still EXIST (`gateway/http/chat-bridge.ts:1224 startSession`
→ `engine.start` :1334; `:1544 handleInbound` → `engine.advance`) and the bridge is still constructed
(`gateway/realmode-composer/build-landing-stack.ts:1418-1489`) and passed to `createLandingServer`
(`:1490-1493`) — **but nothing invokes it**: `landing/server.ts:714-721` — "The `/ws/chat` onboarding
socket that consumed this was removed … the landing server no longer drives a bridge. The field stays
OPTIONAL purely so existing callers that still pass a bridge keep compiling; **nothing in this module
reads it anymore**." The landing server's `websocket` field is a defensive close-stub
(`landing/server.ts:1149-1155`). The resume cron (the other `engine.advance` driver,
`onboarding/interview/resume-cron.ts:236`) is unregistered in Open (only `onboarding_import_running_cron`
at `open/composer.ts:3697`). The llm-router is still **built and threaded**
(`open/composer.ts:1126-1132` → `build-landing-stack.ts:1293`) but can only fire inside
`engine.advance`'s freeform path → wired-but-unreachable.

Chain: chat-bridge D1 header confirms the intent — "onboarding + chat are unified on `/ws/app/chat`.
The bridge + its routed senders below are still the production path that the **engine uses to emit**
onboarding over the app-ws surface" (`chat-bridge.ts:6-11`) — i.e. only the emission/registry half of
chat-bridge is live (import prompts), not the inbound conversational half.

## 3. Deletion-unit inventory

### Shared substrate — KEEP (both "modes" use it; Path-1 + import pipeline need it)
- `onboarding/interview/phase.ts` (phase enum as durable markers), `state-store.ts` / `sqlite-state-store.ts`,
  `extracted-fields.ts`, `required-fields-audit.ts`, `transcript.ts`, `llm-timeouts.ts`
- Engine import subsystem: `notifyImportUpload` (+Locked, engine.ts:2326-2679), `pollImportRunningTick`,
  `engine-import-routing.ts`, `import-running-cron.ts`, the synthesis pipeline (`onboarding/synthesis/`),
  `phase-prompts.ts` STATIC_PHASE_SPECS for import prompts
- `channels/button-store.ts`, the app-ws emission routing (`appWsButtonPromptRouter`,
  `appWsImportProgressRouter`, `open/composer.ts:3156-3264`)
- `runtime/env-flag-tokens.ts` (shared by other env parsers)

### Path-1 exclusive — KEEP (the winner)
- `onboarding/interview/onboarding-preamble.ts` (350 ln), `post-turn-extractor.ts` (652), `button-backed-answer.ts`
- Composer seams: `onboardingSeam` (:2706), `appWsReceiver` (:3266), `on_session_open` (:3415),
  `on_button_choice` (:3551), `watchImportCompletion` (:2653), finalize holder (:2484-2530)
- `gateway/realmode-composer/build-live-agent-turn.ts`, `build-onboarding-finalize.ts`
- Tests: `onboarding-preamble.test.ts`, `post-turn-extractor*.test.ts`, `button-backed-answer.test.ts`,
  `path1-solicited-upload-starts-job.test.ts` (in `onboarding/interview/__tests__/`)

### Engine-conversational exclusive — DELETE candidates (the loser; all verified caller-less on live paths)
| Unit | Evidence |
|---|---|
| `onboarding/interview/llm-router.ts` (1,428 ln) + colocated `llm-router.test.ts` (1,766) | fires only from `engine.advance` freeform; advance has no caller |
| `gateway/realmode-composer/build-llm-router.ts` + composer wiring `open/composer.ts:1126-1132` + `build-landing-stack.ts:678, :1293` | wired-but-unreachable |
| `runtime/onboarding-conversational-flag.ts` + adapter accessors (`platform-adapter.ts:600, :615`; `platform-adapter-local.ts:261-264`) + `shouldConsultRouter` gating (engine.ts:3087-3305) | flag already collapsed; parser "retained only for back-compat callers/tests" |
| engine.ts conversational clusters (span map from `docs/research/refactor-audit-2026-07-02/map-onboarding-interview.md §5`): `start()` (688-1460), `acceptChoice` (1721-1988, already zero-caller), `advance`/`normalAdvance` (1989-2325, 2680-3086), `dispatchRouterDecision` (3306-3792), `consumeChoice` (4085-4971), resume cluster (7362-7788), gap-fill router extraction (6947-7291), personality/name conversational clusters (6094-6650) | ~5-6k of engine.ts's 10,078 lines |
| `interaction-mode.ts` (621 ln — buttons/mixed/freeform pre-router classifier) | consumed only by the router path |
| `resume-cron.ts` (389 ln) | not registered in Open (`open/composer.ts:3697` registers only the import cron) |
| chat-bridge conversational inbound (`startSession` :1224, `handleInbound` :1544, button-choice handling ~:1942/:1996) | `landing/server.ts:714-721` — nothing reads the bridge. CARE: the same module hosts the `WebChatSenderRegistry` + `LiveAgentTurnRunner` types that ARE live (emission + reminder shapes) — split, don't bulk-delete |
| `personality-character-suggester.ts` (602, wired `open/composer.ts:1112`) — fires only from engine conversational phases | `agent-name-suggester.ts` Open wiring already removed 2026-07-01 (`open/composer.ts:1114-1118`) but the MODULE must stay: **Managed imports `buildDiverseAgentNameFallback`** (see §4) |
| Router timeout envs `NEUTRON_ROUTER_HAIKU_TIMEOUT_MS` / `NEUTRON_ROUTER_FIRST_TURN_TIMEOUT_MS` | die with the router |
| Telemetry: `onboarding.router_decision` event | router-only |
| Tests pinning the loser: `engine-router-integration.test.ts`, `llm-router-decision.test.ts`, `interaction-mode-substep-router-bypass.test.ts`, `signup-router-prod-path.test.ts`, `work-interview-projects-extraction-real-path.test.ts`, `gateway/realmode-composer/__tests__/llm-router-composer.test.ts`, large parts of the 83-file engine suite + the conversational integration walkthroughs (`tests/integration/conversational-onboarding-end-to-end` etc.) | test migration is the bulk of the labor |

### Partial / needs care
- **`phase-spec-resolver.ts` (2,099 ln)**: its LLM prompt-copy rephrasing is still LIVE for **import
  prompts** — `import_upload_pending` and `import_analysis_presented` have non-null intent packs
  (`phase-spec-resolver.ts:201, :209`; `import_running` is null :269) and the engine's emission path
  resolves specs for them. The `NEUTRON_LLM_ONBOARDING_PHASES` / `NEUTRON_LLM_ONBOARDING_DEFAULT`
  flag pair lives here (`:2064-2099`, default ON when absent). Post-deletion its only scope is import
  prompt copy — recommend collapsing to ONE path (static or LLM, pick one) and deleting both envs.
- **`engine.start()` crash-resume watermarks** (wow/import re-fire, engine.ts:741-755): `start()` has
  no caller, but before deleting, confirm the composer-side replacements fully cover restart recovery —
  they appear to (`on_session_open` re-arms the import watcher + finalize recovery,
  `open/composer.ts:3419-3456`), and wow dispatch now runs at Path-1 finalize. *Inference: needs a
  restart-recovery test before the delete lands.*
- **Stale comments to fix in the same PR**: `open/composer.ts:1450, :1456` ("→ engine.start"),
  `app-ws-surface.ts:158-165` (same), chat-bridge header, `AS-BUILT.md`/`docs/SYSTEM-OVERVIEW.md`
  flag mentions.

## 4. Managed (neutron-managed) — which mode does hosted onboarding run?

**Path-1, identically.** Managed runs each tenant as a spawned **vendored Open server**:
`src/provision/launcher.ts:109-119` (dev) and `:212-230` (systemd unit) both exec
`bun run <vendor>/open/server.ts`; `buildTenantEnv` (`:72-101`) is the single env contract and does
**NOT** set `NEUTRON_ONBOARDING_CONVERSATIONAL` (it sets HOME/DB/SLUG/PORT/HOST/cookie-secret/
`NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH` + optional `CLAUDE_CODE_OAUTH_TOKEN`). No `NEUTRON_ROLE` either →
tenants boot deployment-mode `'open'` (`gateway/deployment-mode.ts:23-26` precedence, default open;
`build-landing-stack.ts:1343`). The old flag-era descriptions in `neutron-managed/docs/SYSTEM-OVERVIEW.md:203,
:1469` and the p2-v3 research docs describe the **pre-split architecture** — stale, not live config.

**→ No conflict: deleting the engine conversational drive cannot break Managed hosted onboarding**,
because Managed has no code path that reaches it (tenants run whatever the vendored Open runs).

**But the vendor-bump gate pins these Open surfaces** (`src/ops/open-contract.ts:162-206`) — the
deletion PR must preserve them or coordinate a same-window Managed change:
1. `open/server.ts` exists + exports `startOpenServer` (:165-169)
2. `gateway/index.ts` `/healthz` shape (`defaultHealthzHandler`, `project_slug`, `status: 'ok'`) (:171-181)
3. `open/composer.ts` contains `'/chat'` (:183-187)
4. **`onboarding/interview/agent-name-suggester.ts` contains `buildDiverseAgentNameFallback`**
   (:189-196 — `src/claim/url-suggester.ts` imports it for end-of-onboarding personal-URL suggestions).
   Deleting the suggester module outright fails the gate; keep the fallback helper (or move it and
   update the contract + url-suggester in the same coordinated change — allowed, both repos in-window).
5. Every `buildTenantEnv` env name must still be READ somewhere under `open/` or `gateway/` (:198-204).

## 5. Repo-wide dual-path / feature-flag census (item 5)

### Already resolved to one path (verified — no action)
- Vanilla vs React web chat + `NEUTRON_WEB_CHAT_CLIENT`: **deleted** (`landing/server.ts:1158-1173`).
- `chat.tsx` vs `ChatSyncSurface`: collapsed — `app/app/projects/[id]/chat.tsx:18-26` just renders
  `ChatSyncSurface` (PR #122).
- `NEUTRON_PERSISTENT_REPL` + per-turn `claude -p` path: **removed**, persistent REPL unconditional
  (`runtime/adapters/claude-code/index.ts:198-206`).
- Reminders/briefs `web:` vs `app:` live delivery: unified on the app-ws reply path, "NO feature flag"
  (`open/composer.ts:1944-1962, :1993-2029`).
- `/ws/chat` legacy onboarding socket: deleted (`landing/server.ts:16-20, :1151-1152`).

### REMAINING live dual paths / flags (the K11 purge list)
1. **Engine conversational drive vs Path-1** — this report; §3 is the deletion unit. (K11 core.)
2. **Two import pipelines**: per-chunk `history-import/job-runner.ts` (2,104 ln, + `substrate-callers.ts`,
   `pass1/pass2`, `entity-populator.ts`, `gateway/realmode-composer/build-import-job-runner.ts`) is dead
   on every production path — the only composer hard-codes `importUseSynthesis: true`
   (`open/composer.ts:1304`); the header's "retained for the MANAGED hosted import path" rationale is
   void (Managed runs vendored Open → synthesis too). Delete after extracting the shared parsers/types/
   `extractJsonObject` (per `map-onboarding-flows.md §6.2` entanglement list).
3. **`NEUTRON_LLM_ONBOARDING_PHASES` + `NEUTRON_LLM_ONBOARDING_DEFAULT`**: env pair selecting LLM vs
   static onboarding prompt copy (`phase-spec-resolver.ts:2064-2099`). Post-K11 scope shrinks to import
   prompts only → collapse to one implementation, delete both envs.
4. **`openFetch` vs landing auth-gate** (`open/composer.ts:1444-1755` area) — already plan C5.
5. **Engine dual deployment mode**: managed vs open transition tables (`phase.ts:73 LEGAL_TRANSITIONS`
   vs `:129 OPEN_MODE_EXTRA_TRANSITIONS`), `engine.deploymentMode` default `'managed'` (engine.ts:573),
   `engine-slug.ts` (1,086 ln), `slug_chosen`/`identity_oauth`/`instance_provisioned` phases, slug-picker
   hook — **dead in BOTH repos** now (Managed tenants boot open mode, §4). Deletable with K11/K-phase;
   coordinate with the `phase.ts` mode-table tests (`v2-phase-walk` / `open-mode-phase-walk`).
6. **`NEUTRON_ROLE` vs `NEUTRON_DEPLOYMENT_MODE`**: back-compat env alias, precedence ROLE > DEPLOYMENT_MODE
   (`gateway/deployment-mode.ts:23-40`) — flag-debt; drop the alias (Managed sets neither).
7. **Legacy `web:` topic surface**: `landing.registry` (`build-landing-stack.ts:1524-1527`) still exposed;
   no client ever registers `web:` senders (the only client binds `app:<user>` — documented at
   `open/composer.ts:1928-1942`); chat topics still keyed on synthetic `web:` ids (`:1920-1922`).
   Vocabulary/dead-surface cleanup (overlaps plan L/D8 lanes).
8. **`acceptChoice` dead engine API** (engine.ts:1721-1988) + its tests — S1 skeleton, zero production
   callers (already flagged in `map-onboarding-interview.md D4`).
9. **Dead OAuth import sources** (gmail/calendar fetchers, drive/notion/slack stubs under
   `history-import/`) — reachable only from the dead per-chunk runner (`map-onboarding-flows.md §6.7`).
10. **Dev-only auth bypasses** — `NEUTRON_APP_WS_BYPASS` (+`NEUTRON_APP_WS_DEV_SECRET`)
    (`channels/adapters/app-ws/auth.ts:10`), `NEUTRON_DEV_AUTH` (`cores/sdk/auth.ts:408-447`, throws
    without it). Not feature-selection flags, but they are branching auth paths — fold into the C-phase
    security hardening decision (keep-with-guard vs delete).
11. **Config/capability toggles that are NOT dual paths** (recommend leaving, they gate optional
    capability not alternate implementations): `NEUTRON_EMBEDDINGS` (vector memory on/off, degrades),
    `NEUTRON_SKIP_GBRAIN` (doctor skip), model/timeout/path/port/secret envs.

## 6. Impact on the refactor plan

- **K11 can proceed as written and can drop its own uncertainty**: the winner is Path-1, verified
  unconditional; the loser is already dead on live paths, so K11's `[BEHAVIOR]` tag is confirmed
  defensive-only for Open. Managed check: PASS (no conflict), with the `agent-name-suggester`
  fallback + open-contract surfaces as the only cross-repo coupling to preserve.
- **D9 (engine decomposition) shrinks**: post-K11 the engine is the import subsystem + state store —
  target shape ≈ `notifyImportUpload` + cron tick + prompt emission (~2-3k lines instead of 10k).
- Add to K11's flag purge list: `NEUTRON_LLM_ONBOARDING_PHASES`/`_DEFAULT`,
  `NEUTRON_ROLE`-alias drop, router timeout envs; add deletion items #2 (dead import pipeline,
  if not already a K-phase unit) and #5 (managed-mode phase tables — now provably dead in both repos).
- Before the engine.start delete: add a restart-recovery integration test covering the composer-side
  re-arm paths (`on_session_open` watcher re-arm + finalize recovery) that replaced start()'s
  crash-resume watermarks.
