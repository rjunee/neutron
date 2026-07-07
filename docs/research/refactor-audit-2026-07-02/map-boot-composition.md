# Subsystem map: boot-composition

Audit of how Neutron Open boots and wires ~40 workspaces into one Bun process.
Paths covered: `open/server.ts`, `open/composer.ts`, `gateway/index.ts`, `gateway/boot-helpers.ts`,
`gateway/composition.ts` + `gateway/composition/`, `gateway/http/compose.ts`,
`gateway/realmode-composer/`, `gateway/module-graph.ts`, `gateway/deployment-mode.ts`, and
`landing/server.ts`'s role in boot. All line refs verified against working tree @ `d30280c`.

---

## 1. Purpose & responsibilities

This subsystem is the **composition root** of the whole product. It:

1. Resolves single-owner config (NEUTRON_HOME, owner slug, DB path, listen port) from env/CLI/files.
2. Opens the SQLite DB, applies migrations, builds a `GraphComposer`, composes the
   `GatewayModuleGraph` (~14 modules: tools, mcp, channels, cron, reminders, trident, tasks,
   watchdog, cores, …), builds the composed HTTP/WS handler chain, binds one `Bun.serve`
   listener, and manages systemd watchdog + graceful shutdown.
3. Wires every product surface — onboarding engine, landing chat server, app-ws (React/Expo)
   chat, ~20 `/api/app/*` HTTP surfaces, uploads, cores, scribe/gbrain memory, reminders,
   proactive, trident, skill-forge, agent-dispatch — into a single `CompositionInput`.

**There is not one composition root; there is a 4-stage pipeline with two competing stage-1
composers:**

```
ENTRYPOINTS (stage 0)
  open/server.ts  (bun start; root package.json "start")           — Open self-host
  gateway/index.ts import.meta.main (bun start:gateway / systemd)  — Managed prod & dev shell
        │  both call loadGraphComposerFromEnv() first: if NEUTRON_GRAPH_COMPOSER_MODULE is
        │  set, a Managed composer module OUTSIDE this repo is dynamic-imported and wins.
        ▼
STAGE 1 — GraphComposer  (db, project_slug) → CompositionInput
  A) open/composer.ts buildOpenGraphComposer()      — in-repo, single-owner (~3,220-line closure)
  B) Managed realmode-composer.ts                   — OUT of repo, injected via env seam
     both built on the shared builder library gateway/realmode-composer/* (~13k lines, 33 files)
        ▼
STAGE 2 — gateway/composition.ts composeProductionGraph(input)
  buildCoreModules() → graph.register()×14 in fixed order → graph.compose() (topo sort)
  → cron.scheduler.start() → wireCoresSurfaces() → wireConnectOverlay()
  → buildComposedHttpFromComposition()  (CompositionInput → ComposeHttpHandlerInput mapping)
        ▼
STAGE 3 — gateway/http/compose.ts composeHttpHandler()
  the ordered route-precedence ladder → { fetch, websocket }
        ▼
STAGE 4 — gateway/index.ts boot()
  DB open + migrations, listener bind (boot-helpers.bindHttpListener), watchdog, SIGTERM shutdown
```

`landing/server.ts` does **not** boot anything itself. `createLandingServer`
(landing/server.ts:1156) is a pure factory returning `{ fetch, websocket }`; it is constructed
by `buildLandingStack` (gateway/realmode-composer/build-landing-stack.ts:1386), which both
stage-1 composers call. In the Open path its `fetch` is then *wrapped* by `openFetch`
(open/composer.ts:1655) before being handed to the stage-3 ladder as `landing_server.fetch`
(open/composer.ts:3579–3582).

## 2. Module inventory (wc -l, verified)

| File | LOC | Role |
|---|---|---|
| `open/composer.ts` | 3,732 | Open stage-1 composer. `buildOpenGraphComposer` closure = lines 396–3615 (~3,220 LOC, one function) |
| `open/server.ts` | 98 | Open entrypoint; env back-fill + banner |
| `gateway/index.ts` | 603 | `boot()` shell, slug/db resolution, env-seam loader, re-export shim |
| `gateway/boot-helpers.ts` | 1,695 | grab-bag: port/bind + registry + cores backends + chat filters + OAuth gate HTML |
| `gateway/composition.ts` | 435 | stage-2: module registration order + post-compose wiring + input→compose mapping |
| `gateway/composition/build-core-modules.ts` | 999 | constructs the 14 GatewayModule objects |
| `gateway/composition/input/*.ts` (12 files) | 1,341 | `CompositionInput` split into 11 per-concern interfaces (composition-input.ts:31–42) |
| `gateway/composition/wire-cores-surfaces.ts` | 206 | post-compose cores HTTP overlay |
| `gateway/composition/wire-connect-overlay.ts` | 50 | connect on_inbound_message overlay |
| `gateway/composition/message-search-wiring.ts` | 114 | message-search runtime factory |
| `gateway/http/compose.ts` | 1,405 | stage-3 route ladder; `ComposeHttpHandlerInput` (265–682), ladder (833–1320) |
| `gateway/module-graph.ts` | 183 | minimal topo-sorted DI container |
| `gateway/deployment-mode.ts` | 102 | open/managed/connect mode resolver |
| `gateway/realmode-composer/` (33 files) | 12,971 | shared builder library; biggest: build-landing-stack.ts 1,529, build-live-agent-turn.ts 1,490, build-onboarding-handoff.ts 876, build-llm-call-substrate.ts 851, build-onboarding-finalize.ts 760, build-import-job-runner.ts 710 |
| `landing/server.ts` | 1,516 | landing chat server factory (consumed, not a root) |

## 3. Public seams / contracts other subsystems consume

- **`GraphComposer`** type — `gateway/boot-helpers.ts:362–370`: `({db, project_slug}) → CompositionInput | Promise<…>`. THE composer contract. Consumed by `boot()` (gateway/index.ts:206–255) and by the out-of-repo Managed composer.
- **`NEUTRON_GRAPH_COMPOSER_MODULE` env seam** — `gateway/index.ts:540–587` (`loadGraphComposerFromEnv`). Deploy-config injection: dynamic-imports an arbitrary module exporting `buildGraphComposer()`. Fail-fast if `NEUTRON_AUTH_JWKS_URL` is set without it (index.ts:546–556). This seam is why `gateway/boot-helpers.ts` and all of `gateway/realmode-composer/` are de-facto **public API for a private repo**.
- **`CompositionInput`** — `gateway/composition/input/composition-input.ts:31–42` (11 extended interfaces, ~50+ optional fields). The data contract between stage 1 and stage 2. Both composers produce it; every `*-production-composer.test.ts` exercises it.
- **`composeProductionGraph`** — gateway/composition.ts:306. Returns `ComposedProductionGraph` = graph + `{fetch, websocket, composition}` (composition.ts:67–87).
- **`boot(options)` / `BootHandle`** — gateway/index.ts:177/74–97. Consumed by open/server.ts, tests/e2e, and Managed systemd.
- **`buildOpenGraphComposer(options)`** — open/composer.ts:396, with test seams `substrateFactory` + `installTokenHandler` (216–245).
- **`buildLandingStack`** — build-landing-stack.ts:1386, returns `LandingStackWithEngine` (engine + buttonStore + stateStore + importJobRunner + fetch/websocket). The onboarding+chat sub-root shared by both composers.
- **`gateway/index.ts` re-export block** (lines 32–63) — 18 value + 7 type re-exports from boot-helpers "for back-compat" with the injected Managed composer.
- **`resolveOwnerSlug`** — gateway/index.ts:147: `.url_slug` file > `NEUTRON_INSTANCE_SLUG` > `'dev'`. Every JWT-claim equality check depends on it.
- **`resolveDeploymentMode`** — deployment-mode.ts:59: `NEUTRON_ROLE` > `NEUTRON_DEPLOYMENT_MODE` > `'open'`; gates the shared-env credential tier (resolve-llm-credentials.ts header §3) and connect metering (`isHostedRelay`, deployment-mode.ts:96).

## 4. Workspace dependencies

**Manifests are misleading.** `gateway/package.json` declares only cores + gbrain + jose deps,
but actual imports from the boot-composition files reach (relative paths, no workspace
protocol): runtime, persistence, migrations, cron, channels, landing, onboarding, scribe,
reflection, reminders, trident, agent-dispatch, tasks, skill-forge, doc-search, message-search,
auth, jwt-validator, mcp, connect, chat-core (via landing), watchdog. Bun tolerates this
because everything resolves relatively; the manifests do not describe the graph.

**Not-a-workspace dirs in the composition root's import set:** `open/` itself has **no
package.json** (root `"start": "bun run open/server.ts"` — it is part of the root `neutron`
package), and so do `work-board/` and `project-credentials/` (imported at
open/composer.ts:191, 187) — they're absent from the root `workspaces` array. The composition
root literally lives half in the root package, half in `@neutronai/gateway`.

**Inbound (who imports this subsystem):** onboarding/telemetry, runtime/platform-adapter-local,
runtime persistent-repl-substrate (type-level), cores wiring, and — inverted —
`gateway/cores/mount-open-cores.ts:48` imports **up** into `open/agent-profile-backend.ts`.

## 5. Internal layering (as-built)

- `module-graph.ts` (183 LOC) is genuinely clean: minimal DI container, deterministic
  alphabetical topo order (module-graph.ts:177–180), readiness sentinel separate from instance
  (43–59), reverse-order shutdown with per-module error isolation (117–127).
- `composition.ts` post-R5 is a readable thin layer: order-of-registration + 3 post-compose
  wiring steps + the input mapping.
- `compose.ts` is one big but *ordered and documented* precedence ladder.
- The mess concentrates in the two stage-1 layers: `open/composer.ts` (one 3.2k-line closure)
  and `boot-helpers.ts` (six unrelated concerns in one file), plus the naming/placement of
  `realmode-composer/` (Managed vocabulary for what is now the shared library both modes use).

## 6. Architectural debt

### D1 — `buildOpenGraphComposer` is a single ~3,220-line async closure (P0)
open/composer.ts:396–3615. One function, everything closure-captured, at least 15 distinct
responsibility clusters (verified section anchors):

| Lines | Cluster |
|---|---|
| 402–455 | identity/env/skills/persona/cron scaffolding |
| 440–637 | credential pool + FIVE substrate wirings (cc-llm 479, cc-agent 525, ephemeral factory 567, trident warm-fire pool 612, cc-synthesis 760) + prewarm state machine 508–521 |
| 639–758 | agent-dispatch + skill-forge |
| 780–978 | doc-search, scribe, gbrain, reflection |
| 979–1039 | secrets, project-credentials, codex credential, cores mount |
| 1039–1163 | onboarding LLM stack (phase-spec resolver, persona suggesters, llm router, wow picker) |
| 1164–1236 | cookies/start-token/platform adapter/auth claim |
| 1237–1330 | `buildLandingStack` invocation + import-watch holder |
| 1338–1443 | upload pipeline (single-shot, chunked incl. two `await import(...)`s at 1367–1374, sweeper, resume) |
| 1444–1653 | cold-start redirect + resumable-state probe + **HTML string injection of React bootstrap scripts** (1481–1630) + start-token claim |
| 1655–1755 | `openFetch` — a hand-rolled route/cookie/SPA ladder wrapping landing.fetch |
| 1765–2211 | chat topics/history surfaces, app-ws push registry, reminders, proactive, tasks config, owner auth resolver, docs/tabs/tasks/upload surfaces |
| 2138–2210 | work board + trident run store + credentials surfaces |
| 2212–2530 | project create/kickoff/scaffold, onboarding finalize, import-completion watcher (3s poll loop, 2479–2530) |
| 2531–3081 | onboarding seam for live-agent turns, app-ws chat turn, send-reply builder (2701–2840), project-opening recovery, typing emitter, `emitOnboardingPrompt` durable/ephemeral routing (2928–3081) |
| 3082–3425 | app-ws receiver + `createAppWsSurface` wiring |
| 3426–3613 | 190-line return literal assembling CompositionInput |

Consequences: nothing inside is unit-testable in isolation (open/__tests__/* each boot the
entire composer); every feature PR appends here (git log shows trident/onboarding/import fixes
all landing in this one file); closure-captured mutable state (`prewarmSettled`,
`lastProjectsSnapshot`, `seededOnboardingTopics`, four late-bound holder objects) makes
extraction risky without a map. This is the single highest-leverage refactor target.

### D2 — `gateway/boot-helpers.ts` is a grab-bag god file with a hidden external contract (P1)
Six unrelated concerns in 1,695 lines: (a) genuine boot shell — `resolveListenPort` 224,
`bindHttpListener` 304, `resolveRepoRoot` 475; (b) Managed owner-registry — 57–223; (c) chat
command filters — 519–744; (d) `buildCoresBackendFactories` — 745–1225 (480 LOC of cores
backend construction); (e) research LLM + OAuth config — 1259–1349; (f) Max-OAuth gate with
**inline HTML page rendering** — 1389–1695. Per-symbol grep shows 8 exports with **zero
in-repo non-test consumers**: `createTasksCoreOwnerRegistry`, `defaultListProjects`,
`loadAnthropicOAuthConfigFromEnv`, `resolveIdentityPublicBaseUrl`, `resolveBaseDomain`,
`buildMaxOAuthGateHandler`, `buildGateLandingServer`, `buildMaxOauthHandoffUrl` — they exist
solely for the out-of-repo Managed composer reached via the env seam, but nothing in the repo
declares that contract. `gateway/index.ts:32–63` re-exports the whole surface "for back-compat".
Any refactor that renames/moves these silently breaks Managed production.

### D3 — Adding one HTTP surface requires hand-edits in 4–5 bookkeeping sites (P1)
The chain: (1) field on a `composition/input/*.ts` interface; (2) field-by-field mapping in
`buildComposedHttpFromComposition` (composition.ts:137–259 — 30 near-identical if-blocks);
(3) the 31-term `hasAnyChainedSurface` boolean (composition.ts:264–295); (4) field on
`ComposeHttpHandlerInput` + a ladder step in compose.ts (833–1320); (5) if browser-facing,
`LANDING_PATHS` (compose.ts:722–752) and/or `isGatedUserFacingRoute` (806–818). The repo's own
comments document the bug class this breeds ("fell through to the default 404", ISSUES #59
pattern, repeated at compose.ts:731–748). ISSUE #32 fixed the *test bypass* of site (2) but the
O(n)-files-per-route shape remains.

### D4 — Three stacked hand-rolled route ladders on the Open request path (P1)
A GET in Open traverses: compose.ts `dispatchRequest` ladder (steps 0…4, lines 963–1320) →
`openFetch` cookie/cold-start/SPA ladder (open/composer.ts:1655–1755) → `landing/server.ts`
internal route dispatch. Each layer has its own path lists that must agree (`LANDING_PATHS`,
`isSpaClientRoute`, openFetch's inline checks, landing's routes). Cookie-mint logic exists in
both the compose.ts authGate stitch (894–948, Managed) and openFetch (1668–1753, Open) —
parallel implementations of "mint owner session on first valid token".

### D5 — Duplicated credential resolution, Open vs Managed (P2)
`resolveOpenLlmPool` (open/composer.ts:287–316; env OAuth > env API key > ambient Keychain)
explicitly documents that it "mirrors the Managed resolver's precedence"
(open/composer.ts:249–251) of `gateway/realmode-composer/resolve-llm-credentials.ts` (309 LOC,
4-tier). Two resolvers, one informal sync contract, and the `'ambient'` kind exists only in the
Open one (runtime/credential-pool.ts:33 notes this). A tier change in one silently diverges the
other.

### D6 — `boot()` reads `process.env` directly; the Open entrypoint mutates global env as its DI mechanism (P1)
open/server.ts:47–73 writes `OWNER_HOME`, `NEUTRON_DB_PATH`,
`NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET` into `process.env` because `boot()` resolves DB path
(gateway/index.ts:118–122), slug (147–157), port (272), and host (308) from `process.env`
regardless of what the composer was configured with. The docblock (open/server.ts:39–45) admits
a divergent env arg "would silently desync". Config resolution is smeared across ~25 env vars
read at open/server.ts, gateway/index.ts, boot-helpers, open/composer.ts, deployment-mode.ts,
realmode-composer builders, and re-read at runtime via `loadInstanceEnvOverlay`
(load-instance-env-overlay.ts:68 — on-disk `.env` re-parsed per dispatch). There is no single
typed BootConfig.

### D7 — Layering inversion: gateway imports up into open/ (P2)
`gateway/cores/mount-open-cores.ts:48` imports `open/agent-profile-backend.ts` while open/
imports gateway/ ~40 times — a directory-level cycle (open/composer.ts:110 imports
mount-open-cores which imports open/). Compiles under Bun/TS but defeats the declared
edge→substrate layering and blocks ever making `open/` (or `gateway/`) a real package boundary.

### D8 — "realmode-composer" is Managed vocabulary naming the shared library (P2)
gateway/realmode-composer/ (13k LOC) is the builder library BOTH modes use (open/composer.ts
imports 15 of its modules), yet name, docblocks ("per-instance", "realmode", "the Managed
composer") and several members (e.g. `resolve-llm-credentials.ts` tiers keyed on Managed
deployment) describe only the Managed use. Mirrors the "tenant"/`internal_handle` rename debt
(open/composer.ts:405 `const internal_handle = project_slug` — the single-owner value simply
aliased into multi-tenant vocabulary; `project_slug` itself is the renamed tenant slug).

### D9 — Dual entrypoints with duplicated ignition logic (P3)
open/server.ts:93–98 and gateway/index.ts:589–603 both do `loadGraphComposerFromEnv` → `boot`
with near-identical TLA comments. Divergence risk is low but real (open/server.ts back-fills
env; gateway/index.ts doesn't — a `bun start:gateway` on a fresh Open box boots healthz-only
with the `~/.local/share/neutron/owner.db` fallback instead of NEUTRON_HOME).

### D10 — CompositionInput is a ~50-field optional-bag god interface (P2)
composition/input/* totals 1,341 LOC of interface. Almost every field is optional, so a
composer that forgets one compiles clean and the surface silently 404s — the exact regression
class the repo's history keeps re-fixing (open/composer.ts:1757–1764 sidebar 404;
:3498–3513 import-running cron never ticked on Open; :3460–3463 integrations surface never
mounted in Open). The type system provides no "Open profile requires these fields" checking.

## 7. Dead / legacy code candidates (evidence-based)

- `gateway/boot-helpers.ts` exports with zero in-repo non-test consumers (per-symbol grep,
  2026-07-02): `createTasksCoreOwnerRegistry` (:63), `defaultListProjects` (:420),
  `loadAnthropicOAuthConfigFromEnv` (:1259), `resolveIdentityPublicBaseUrl` (:1350),
  `resolveBaseDomain` (:1358), `buildMaxOAuthGateHandler` (:1389), `buildGateLandingServer`
  (:1642); `buildMaxOauthHandoffUrl` (:1461) is referenced only by its own test. **Caveat:**
  all are plausibly live in the private Managed repo via the env seam — "dead in Open," not
  provably dead. Cannot confirm from this repo; deletion requires a Managed-side audit.
- `gateway/index.ts:32–63` re-export shim — pure back-compat for the injected composer; every
  in-repo consumer already imports `boot-helpers.ts` directly.
- `boot()`'s `composition.http_handler` full-override path (gateway/index.ts:230–232): no
  in-repo composer sets `http_handler`; only `BootOptions.httpHandler` (tests) exercises the
  override ladder. The composer-supplied variant looks vestigial (pre-Sprint-18).
- `buildImportJobRunnerHook` per-chunk path is self-described as "retired" for Open
  (open/composer.ts:1284, build-landing-stack.ts:444) yet still built/wired behind an opt-in
  at build-landing-stack.ts:1117–1145 — legacy path kept alive for Managed.
- The no-op `topic_handler` / `approval_notifier` / `watchdog_notifier` stubs
  (open/composer.ts:3434–3436) exist only to satisfy required CompositionInput fields —
  Telegram-shaped required fields in a single-owner composition.

## 8. Test posture

**Strong at the seams, structurally blind inside the god closure.**

- Boot shell: `gateway/boot.test.ts`, `boot-init-cleanup.test.ts` (init-failure resource
  release), `deterministic-bind.test.ts` (#314 EADDRINUSE retry/fail-loud),
  `module-graph.test.ts`, `sd-notify.test.ts`, and `graph-composer-env-seam.test.ts` — a real
  subprocess test pinning the env-seam boot (guards the TLA-cycle regression documented at
  index.ts:525–538).
- Stage 2/3: ~80 files in `gateway/__tests__/`, many named `*-production-composer.test.ts`
  that serve `graph.fetch` — post-ISSUE-#32 they exercise the real
  composition→compose mapping instead of re-rolling `composeHttpHandler` (composition.ts:53–65).
- Open: 30 files in `open/__tests__/` (open-boot-shell, wiring tests per feature,
  resolve-open-llm-pool, start-token single-use). realmode-composer: ~40 files incl. 12
  build-live-agent-turn variants.
- **Gap:** everything inside `buildOpenGraphComposer` is reachable only by booting the whole
  composer; internal helpers (`emitOnboardingPrompt`, `watchImportCompletion`,
  `buildAppWsSendReply`, `openFetch`) have no direct units — the exported pure helpers
  (`resolveOpenImportPromptEmission`, `resolveImportRunningStatusDelivery`) show the intended
  pattern but cover ~2% of the closure. Wiring tests are also inherently *presence* tests: they
  catch a missing field only if someone wrote the test after the outage (see D10 history).
- Flake character: full-composer boots are heavy; known PGLite boot flake in gbrain-adjacent
  suites (fixed via mutex+retry per project memory); port-0 binding keeps listener tests safe.

## 9. Load-bearing subtleties a NO-CHANGE refactor must preserve

1. **Env mutation ordering** — open/server.ts:58–73 must run before `boot()`; boot re-reads
   `process.env` for DB path/slug/host/port independently of the composer's `env` option
   (gateway/index.ts:118–122, 147–157, 272, 308). Introducing a config object without changing
   both sides in lockstep desyncs DB path vs owner_home.
2. **Module registration order + post-compose sequence** — composition.ts:331–349: replToolBridge
   registered AFTER mcp (deps:['mcp'], P0-1); `cron.scheduler.start()` only AFTER
   `graph.compose()` (S15 comment 351–377 — jobs register during module init; starting earlier
   loses jobs, never starting strands import_running); then `wireCoresSurfaces` →
   `wireConnectOverlay` → `buildComposedHttpFromComposition` (overlays mutate the composition
   the HTTP chain is then built from, 383–415). Topo order is alphabetical-deterministic
   (module-graph.ts:177–180) — same boot order every restart.
3. **Lifecycle error paths** — composeProductionGraph tears the graph down if HTTP composition
   throws (composition.ts:413–426); boot() closes db + best-effort graph shutdown on composer
   throw (index.ts:236–255). Shutdown order is fixed: listener stop → STOPPING=1 → watchdog
   clear → graph.shutdown → shutdownAllPersistentRepls (orphaned-claude fix, index.ts:420–445)
   → realmode_cleanups → db.close (index.ts:385–458). `stop()` auto-forces under
   NODE_ENV=test (index.ts:352–358) or `bun test` hangs.
4. **HTTP ladder ordering** — authGate evaluated FIRST but only for gated routes, and its
   Set-Cookie is stitched onto the downstream response (compose.ts:894–948); devMintSession
   ahead of all (950–962); chunked upload before single-shot import upload (ladder step 0d-pre
   vs 0d); landing path-SET match before connect API so a landing 404 can't shadow it;
   `LANDING_PATHS` must enumerate every landing route (compose.ts:722–752) or that route 404s —
   the historically recurring bug class.
5. **Open cookie/start-token gate** — `?start=` tokens are single-use (JTI claimed via
   `InMemoryConsumedTokens`, open/composer.ts:1638–1653); cookie minted only on first claim
   (1737–1748); valid-cookie-but-no-resumable-state cold-starts instead of serving chat
   (1686–1690 — stale-cookie-over-wiped-DB wedge). React bootstrap scripts are injected by
   string-replace on the `/chat-react.js` script tag (1616–1626) — markup changes in landing
   HTML break it silently.
6. **Prewarm contract** — `prewarmSubstrate` promise NEVER rejects (open/composer.ts:3661–3684);
   boot does not await it; `prewarmSettled` flag elevates the conversational timeout for every
   turn in the cold window (508–521, 1049–1056); `awaitPrewarmReady` is capped
   (NEUTRON_PREWARM_AWAIT_CAP_MS, default 35s). Making prewarm awaited-at-boot or rejecting
   changes first-turn UX and can hang boot.
7. **Late-bound holder pattern** — `dispatchBoardHolder` (654–663), `importWatchHolder` (1329),
   `onboardingMsgHolder` (2321), `appWsHolder` (2689): construction-order cycles resolved by
   mutable holders filled later in the same closure. Extraction must preserve fill-before-use
   timing (comments assert "every runtime dispatch happens long after composition").
8. **Warm vs ephemeral substrate identity** — instance-id prefixes (`cc-llm-`, `cc-agent-`,
   `cc-synthesis-`, `cc-trident-fire-<djb2(cwd)>`, ephemeral `cc-trident-`/`cc-dispatch-`) are
   the pool keys; trident fire substrate must be warm (non-ephemeral) or the detached Workflow
   aborts on settle (590–633); only `cc-agent-` gets `enableToolBridge` (535–541).
9. **`boot()` frozen slug** — `project_slug` is resolved once at boot (index.ts:184); rename
   flows depend on the `.url_slug` file + restart (147–157 Argus note). Composition mutates and
   returns the SAME input object reference (composition.ts:81–86) — consumers rely on identity.
10. **Bun.serve fetch closure** — the chained fetch is selected per-request inside the serve
    arrow (index.ts:316–323) so the live `server` reference reaches WS upgrades; hoisting the
    choice out of the arrow breaks `/ws/app/chat` upgrade.
11. **maxRequestBodySize** aligned to import cap + 64MB slack (index.ts:302) — lowering it
    resurrects the silent pre-handler 413 on large exports.

## 10. What the refactor should do here

1. **Decompose `buildOpenGraphComposer` along the section map in D1** into ~12 feature-wiring
   modules (`open/wiring/substrates.ts`, `wiring/memory.ts`, `wiring/app-surfaces.ts`,
   `wiring/onboarding.ts`, `wiring/uploads.ts`, `wiring/http-shell.ts`, …), each taking a narrow
   typed context and returning its CompositionInput slice; the composer becomes a ~150-line
   orchestrator that spreads slices. The late-bound holders (subtlety 7) become explicit
   two-phase `create()/bind()` seams. Existing open/__tests__ wiring tests are the behavior lock.
2. **Declare the Managed seam explicitly**: a `gateway/composer-contract.ts` module that is the
   ONLY export surface `NEUTRON_GRAPH_COMPOSER_MODULE` composers may import (types + the
   helpers grep-verified as externally consumed), so boot-helpers can be split into
   `listen.ts` / `owner-registry.ts` / `cores-backends.ts` / `chat-filters.ts` /
   `max-oauth-gate.ts` without guessing what the private repo touches.
3. **Make surface registration data-driven** to collapse D3: a single
   `{ key, route match, handler, gated?, websocket? }` registry that generates the
   CompositionInput mapping, `hasAnyChainedSurface`, and the compose.ts ladder entry from one
   declaration — preserving the current fixed precedence as an explicit ordered list.
4. **Introduce one typed BootConfig** resolved once (env + CLI + files) at the entrypoints and
   threaded down, replacing the process.env writes in open/server.ts (D6) — keeping the
   documented lockstep by making boot() consume the same object.
5. **Fix the open/↔gateway inversion** (D7) by moving `agent-profile-backend` behind an
   injection point in `mountOpenCores`, then rename `realmode-composer/` →
   `gateway/wiring/` (or similar) as part of the tenant-vocabulary rename (D8).
6. Unify the two credential resolvers (D5) behind one precedence table with an
   `allowAmbient` flag, covered by the existing resolve-open-llm-pool + resolve-llm-credentials
   tests.
