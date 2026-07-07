# Composition critic — the boot/wiring story of Neutron Open

Charter: compare `open/composer.ts` vs `open/server.ts` vs `gateway/boot-helpers.ts` vs
`gateway/http/compose.ts` vs `gateway/realmode-composer/` vs `landing/server.ts`. Count the
composition roots, name the duplication, count the touch-points for wiring a new feature, and
propose a single composition architecture with an incremental migration path.

All line references verified against the working tree (branch `main`, HEAD `d30280c`) on
2026-07-02. Where I relied on the subsystem maps I re-verified the load-bearing claims in code;
divergences from the maps are called out.

---

## 1. How many composition roots exist?

The honest answer: **one nominal pipeline, but at least seven distinct places where wiring
decisions live — two of which are competing top-level composers, and one of which is in a
different (private) repository.**

| # | Root | Location | Size | Role |
|---|------|----------|------|------|
| 1 | `buildOpenGraphComposer` | `open/composer.ts:396–3615` | 3,732-line file; one ~3,220-line async closure | Open stage-1 composer: builds *everything* product-facing |
| 2 | Managed composer (private repo) | injected via `NEUTRON_GRAPH_COMPOSER_MODULE`, loader at `gateway/index.ts:540–587` | unknown (out of repo) | Competing stage-1 composer; imports `boot-helpers.ts` + `realmode-composer/*` as an undeclared ABI |
| 3 | `buildLandingStack` | `gateway/realmode-composer/build-landing-stack.ts:1386` (1,529 LOC, 34+ option fields at :93–440) | shared sub-root | Onboarding engine + landing server + chat bridge + import runner; called by BOTH stage-1 composers (Open at `open/composer.ts:1237`; Managed out of repo) |
| 4 | Cores sub-root | `gateway/cores/mount-open-cores.ts` + `gateway/boot-helpers.ts:buildCoresBackendFactories` (~480 LOC, :745–1225) | sub-root | Core backends, OAuth token manager, chained chat-command filter |
| 5 | `composeProductionGraph` + `buildCoreModules` | `gateway/composition.ts:306`, `gateway/composition/build-core-modules.ts` (999 LOC) | stage-2 root | The 14-module `GatewayModuleGraph` + two **in-place mutating** post-compose overlays (`wire-cores-surfaces.ts`, `wire-connect-overlay.ts`, ordering fixed at composition.ts:383–415) |
| 6 | `composeHttpHandler` | `gateway/http/compose.ts:833–1320` | stage-3 root | The ~30-branch first-match-wins route ladder + auth-gate stitch + `LANDING_PATHS` |
| 7 | `boot()` | `gateway/index.ts:177` | stage-4 root | DB open + migrations, port bind, watchdog, shutdown ordering — and its own **independent** config resolution from `process.env` (`resolveDbPath` :118–122, `resolveOwnerSlug` :147–157, port :272, host :308) |

Plus `landing/server.ts:createLandingServer` (:1156) — not a boot root (it's a factory) but it
owns a **third route ladder** (`landing/server.ts:1301–1469`) that the stage-3 ladder and the
Open `openFetch` wrapper must both agree with.

And two **entrypoints** duplicating ignition: `open/server.ts:93–98` and
`gateway/index.ts:589–603` both run `loadGraphComposerFromEnv() → boot()`, but only
`open/server.ts:58–73` back-fills `OWNER_HOME`/`NEUTRON_DB_PATH`/cookie secret — so `bun
start:gateway` (package.json:49) on an Open box silently boots a healthz-only shell against the
`~/.local/share/neutron/owner.db` fallback (gateway/index.ts:121).

### The two DI idioms

There is a genuinely clean DI container in the repo — `gateway/module-graph.ts` (183 LOC,
topo-sorted, deterministic alphabetical order at :177–180, reverse-order shutdown). But it hosts
only **14 infrastructure modules** (`build-core-modules.ts:153–727`: tools, mcp,
repl-tool-bridge, channels, cron, reminders, trident, tasks, watchdog, telemetry, platform,
cores, approval, process-registry). `graph.get()` consumers are almost exclusively inside
`build-core-modules.ts` itself plus `composition.ts:371`. Everything else — the landing stack,
chat bridge, all ~20 app surfaces, five substrate pools, memory, uploads, onboarding seams — is
wired by **closure capture** inside the stage-1 composer, with construction-order cycles
resolved by four mutable late-bound holder objects (`dispatchBoardHolder` open/composer.ts:654,
`importWatchHolder` :1329, `onboardingMsgHolder` :2321, `appWsHolder` ~:2689). Two dependency-
injection systems coexist; the principled one covers perhaps 15% of the system.

---

## 2. What is duplicated between the roots?

Verified duplications, most severe first:

**D-a. Four parallel hand-maintained lists of the same surface set — already diverged.**
Every chained surface appears in (1) a `composition/input/*.ts` interface field, (2) the
`buildComposedHttpFromComposition` if-block mapping (composition.ts:137–259), (3) the
`hasAnyChainedSurface` boolean (composition.ts:264–295), (4) the `ComposeHttpHandlerInput`
field + destructure + ladder step (compose.ts:265–682, :834–872, :950–1320).
**The lists have already drifted**: `chat_history_surface` (:155), `chat_topics_surface`
(:158), `import_resume_handler` (:173) and `auth_gate` (:254) are mapped but absent from
`hasAnyChainedSurface` — a composition supplying only those fields silently gets `null` (no
HTTP chain, healthz-only boot). Masked today because every real composer sets
`landing_server`.

**D-b. Two auth gates; the tested one is dormant, the live one is an anonymous closure.**
`landing/auth-gate.ts` (655 LOC, well-tested) is consumed by compose.ts:895–932 via
`composition.auth_gate` — which **no production code in this repo ever sets** (grep verified:
zero non-test setters). The *live* Open gate is the `openFetch` closure
(open/composer.ts:1655–1755): cookie check, cold-start redirect, SPA deep-link mint,
single-use `?start=` claim, React-bootstrap HTML string-injection — none of it importable or
unit-testable. Cookie-mint logic exists in both: compose.ts stitches the gate's Set-Cookie
onto downstream responses (:934–948, sliding 30-day refresh) while `openFetch` mints via
`formatOwnerSetCookie` (open/composer.ts:3624–3632), itself a documented fork of
`landing/session-cookie.ts:formatSetCookie` ("mirrors … but drops `Secure` on plain http").

**D-c. Three stacked route ladders whose path lists must agree by hand.**
An Open GET traverses compose.ts `dispatchRequest` (steps 0…4, :950–1320) → `openFetch`
(open/composer.ts:1655–1755) → `landing/server.ts` internal ifs (:1301–1469). compose.ts
carries `LANDING_PATHS` (:722–752), a manual allowlist of the landing server's routes whose
in-code comments document **three production-404 incidents** (`/start` ISSUES #59,
`/api/v1/chat/history`, `/mobile` ISSUES #208). `isSpaClientRoute` is consulted in all three
layers (compose.ts:815, open/composer.ts:1702, landing).

**D-d. Two credential resolvers with a comment-only sync contract.**
`resolveOpenLlmPool` (open/composer.ts:287–316) explicitly documents that it "mirrors the
Managed resolver's precedence" of `gateway/realmode-composer/resolve-llm-credentials.ts`
(309 LOC); the `'ambient'` kind exists only on the Open side.

**D-e. A forked surface.** `open/chat-topics-surface.ts` (294 LOC) re-implements
`gateway/http/chat-topics-surface.ts` with the same wire shape but a different data source
(projects table vs button_prompts) — its own header narrates the incident that spawned it.

**D-f. Duplicated ignition** (entrypoints, above), and a vestigial third handler path:
`composition.http_handler` full-override (gateway/index.ts:230–232) has **no in-repo setter**.

---

## 3. How does a new feature get wired today? (touch-point count)

Traced end-to-end with a real, recent surface (`app_codex_credential_surface`, grep-verified):

| # | Edit site | File |
|---|-----------|------|
| 1 | Surface factory (the feature itself) | `gateway/http/codex-credential-surface.ts` |
| 2 | `CompositionInput` field | `gateway/composition/input/app-surfaces-input.ts:288` |
| 3 | Mapping if-block | `gateway/composition.ts:233–237` |
| 4 | `hasAnyChainedSurface` term | `gateway/composition.ts:291` |
| 5 | `ComposeHttpHandlerInput` field + doc | `gateway/http/compose.ts:587` |
| 6 | Destructure entry | `gateway/http/compose.ts:863` |
| 7 | Ladder step (choose precedence position) | `gateway/http/compose.ts:1151–1153` |
| 8 | Construct + return-literal field in the Open composer | `open/composer.ts:2196, 3606` |
| 9 | The **private Managed composer** (second repo) | out of repo |
| 10 | If browser-facing: `LANDING_PATHS` / `isGatedUserFacingRoute` | `gateway/http/compose.ts:722–752, 806–818` |
| 11 | A `*-production-composer.test.ts` reachability test — effectively mandatory, because the all-optional type system cannot catch omission | `gateway/__tests__/` |

**≈8–10 coordinated edit sites across 4+ files and 2 repositories** for one HTTP surface — and
forgetting sites 2–8 produces a *silent 404*, the regression class the repo's own comments
document repeatedly (open/composer.ts:1757–1764 sidebar 404; :3498–3513 import cron never
ticked; :3460–3463 integrations never mounted).

**Negative-space evidence** of the cost: the Open composer wires only 10 of the ~20 app
surfaces. `app_reminders_surface`, `app_focus_surface`, `app_focus_current_surface`,
`app_admin_surface`, `app_persona_surface`, `app_devices_surface`, `app_backups_surface`,
`app_launcher_surface`, `app_connect_auth_surface` have **zero production setters anywhere in
this repo** (grep verified). The Expo client ships tabs/screens against several of these
(admin console, backups, reminders — see map-mobile-app). Nothing in the type system or tests
distinguishes "Open deliberately doesn't ship reminders-over-HTTP" from "someone forgot" —
that is precisely what a ~67-field all-optional `CompositionInput`
(`gateway/composition/input/*.ts`, 11 sub-interfaces) cannot express.

---

## 4. Findings

### F1 (P0) — `buildOpenGraphComposer` is a 3,220-line closure that is simultaneously the composition root, an HTTP middleware, and an HTML templater
`open/composer.ts:396–3615`. Fifteen responsibility clusters (substrates :440–637, memory
:780–978, uploads :1338–1443, cookie/HTML-injection :1444–1653, `openFetch` :1655–1755, app-ws
receiver :3082–3425, 190-line return literal :3426–3613). Beyond size: **request-path code
lives inside the composition root** — `openFetch` and `withReactBootstrap` do per-request
cookie auth and string-replace HTML injection from inside the composer closure, so the hottest
security-relevant path in Open is an anonymous closure testable only by booting the entire
composer. Closure-captured mutable state (`prewarmSettled` :516–521, `fireSubstrateByCwd`
:612, `lastProjectsSnapshot`, four late-bound holders) makes extraction risky without a map —
which is exactly why every feature PR appends here instead.

### F2 (P1) — Surface registration is a 4-list copy-machine that has already desynced
Evidence in §2 D-a and §3. The `hasAnyChainedSurface` divergence
(composition.ts:264–295 missing 4 mapped fields) is a latent boot-shape bug today and proof
the pattern does not scale. Fix: one data-driven surface registry (see §5).

### F3 (P1) — The Managed composer ABI is load-bearing and invisible
The `NEUTRON_GRAPH_COMPOSER_MODULE` seam (gateway/index.ts:540–587) makes an unbounded set of
in-repo symbols de-facto public API for the private repo: 8 `boot-helpers.ts` exports have
zero non-test in-repo consumers (grep verified: `createTasksCoreOwnerRegistry` :63,
`defaultListProjects` :420, `loadAnthropicOAuthConfigFromEnv` :1259,
`resolveIdentityPublicBaseUrl` :1350, `resolveBaseDomain` :1358, `buildMaxOAuthGateHandler`
:1389, `buildGateLandingServer` :1642, `buildMaxOauthHandoffUrl` :1461); the
`gateway/index.ts:32–63` re-export shim exists purely for that composer;
`loadInstanceEnvOverlay` (load-instance-env-overlay.ts:68) has **no in-repo caller at all**
yet documents itself as wired by "the production composer". Any rename/move/split in
`boot-helpers.ts` or `realmode-composer/` can break Managed production with zero in-repo
signal — this is the single biggest *risk multiplier* for the whole refactor, because the
refactor's main targets (boot-helpers, realmode-composer) ARE the ABI.

### F4 (P1) — Config is ~35 env vars smeared across 6+ layers; `process.env` mutation is the DI mechanism
35 distinct `NEUTRON_*` vars across the boot path (grep), 25 in the core boot files alone,
plus `OWNER_HOME`/`CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`. `open/server.ts:47–73`
mutates `process.env` because `boot()` re-reads env independently of the composer
(gateway/index.ts:118–122, 147–157, 272, 308) — the docblock itself admits a divergent env arg
"would silently desync". The dual-entrypoint trap (§1) is the symptom: same process, different
config resolution depending on which file you start.

### F5 (P1) — Three stacked route ladders + two auth gates on the Open request path
Evidence §2 D-b/D-c. Consequences: (a) `LANDING_PATHS` is a recurring production-404 factory
(3 in-comment incidents); (b) the *tested* auth gate is dead code in Open while the *live*
gate is unnamed and untested as a unit; (c) route-ownership knowledge for one URL can live in
three files that only agree by convention.

### F6 (P2) — `CompositionInput` is a ~67-field all-optional bag with no per-profile required set
11 sub-interfaces, ~67 optional fields; the compiler accepts any subset. Documented silent-404
regressions (§3) and the unwired-surface negative space (§3) are the cost. Fix: profile types
(`OpenComposition = CompositionBase & Required<Pick<CompositionInput, 'app_ws_surface' | …>>`)
so the Open composer fails to compile when a surface Open ships goes missing.

### F7 (P2) — Two DI idioms; the module graph covers ~15% of the system; post-compose overlays mutate the shared input object in a fixed order
§1 "two DI idioms". `composeProductionGraph` additionally mutates and returns the SAME
`CompositionInput` reference (composition.ts:81–86, 428–434) after `wireCoresSurfaces` →
`wireConnectOverlay` overlays (:383–415) — order-sensitive, in-place, caller-visible. The
four late-bound holders are hand-rolled two-phase initialization without a named pattern.

### F8 (P2) — Layer cycles at the composition seams block any real package boundary
`gateway/cores/mount-open-cores.ts:48` imports `open/agent-profile-backend.ts` while
`open/composer.ts:110` imports mount-open-cores (gateway↔open directory cycle);
`gateway/http/chat-bridge.ts:116` imports `realmode-composer/build-onboarding-handoff.ts`
while 4 realmode-composer files import chat-bridge (http↔wiring cycle; grep verified:
build-landing-stack.ts:44, build-phase-spec-resolver.ts:53, build-live-agent-turn.ts:74,
build-wow-dispatcher.ts:89–90). Also `landing/server.ts:41` imports
`onboarding/interview/final-handoff-config.ts` (edge→product). These make "gateway",
"open", "landing" un-packageable as-is.

### F9 (P2) — `buildLandingStack` is a second god sub-root with a 34+-field input contract
`gateway/realmode-composer/build-landing-stack.ts` (1,529 LOC; input fields :93–440 include
engine hooks, wow machinery, import runner seams, slug-picker, web registry…). Both composers
couple to onboarding internals through this one bag. Its directory's name
("realmode-composer" = Managed vocabulary) misdescribes the shared library both modes use —
20 import lines in open/composer.ts alone.

### F10 (P2) — Duplicated credential resolution (Open vs Managed tiers)
§2 D-d. A tier change on one side silently diverges the other; `'ambient'` is Open-only by
design but nothing encodes that as policy rather than accident.

### F11 (P3) — Vestigial composition paths add noise exactly where clarity matters most
`composition.http_handler` override with no in-repo setter (gateway/index.ts:230–232);
dormant `auth_gate` branch in compose.ts (Open never sets it); no-op Telegram-shaped
*required* stubs (`topic_handler`/`approval_notifier`/`watchdog_notifier`,
open/composer.ts:3434–3436) satisfying multi-channel required fields in a single-owner
product; the `open/chat-topics-surface.ts` fork; two names for one entrypoint flow.

---

## 5. Proposed single composition architecture

### Target shape

```
config.ts                 — ONE typed, frozen BootConfig resolved once per process
                            (env + CLI + files: NEUTRON_HOME, dbPath, slug, port, host,
                            cookieSecret, credentials, claimUrl, …). boot() and every
                            wiring module take BootConfig; no process.env reads below
                            the entrypoint.

feature wiring modules    — each feature ships wiring/<feature>.ts exporting
                            defineFeature({
                              name, deps: [names],
                              services(ctx): register into the module graph,
                              surfaces: RouteSlot[],       // see below
                              tools?, cron?, cleanup?,
                            })
                            ctx is a NARROW typed slice (db, config, graph.get, log) —
                            not the whole closure.

RouteSlot                 — { key, owns(req) | pathSet, handler, gated?, websocket?,
                            precedence: number }
                            ONE declaration generates: the CompositionInput field,
                            the mapping, hasAnyChainedSurface, the compose.ts ladder
                            entry, and the gate/landing path lists. Precedence is an
                            explicit ordered array, not comment lore.

profiles                  — profiles/open.ts, profiles/managed-contract.ts:
                            an ordered list of feature modules + a Required<> type
                            for the surfaces that profile ships. The Open "composer"
                            becomes ~150 lines of profile assembly.

composer-contract.ts      — the ONLY import surface a NEUTRON_GRAPH_COMPOSER_MODULE
                            composer may use (GraphComposer, CompositionInput, the
                            grep-verified externally-consumed helpers). Pinned by an
                            export-name snapshot test.

auth gate                 — one AuthGate interface (compose.ts already has the seam);
                            Open supplies a named, unit-tested OpenOwnerGate module
                            (today's openFetch logic verbatim); Managed keeps
                            landing/auth-gate.ts. openFetch dies.

landing route manifest    — landing/server.ts exports its route predicate/set;
                            compose.ts consumes it; LANDING_PATHS becomes a generated
                            artifact with a transition test (generated == literal).
```

### Incremental migration path (each step lands green, behavior-identical)

0. **Characterization first.** Add a route-matrix test per profile: boot the real composer,
   assert the exact set of mounted routes (method+path → status class) and the ladder ORDER
   (chunked-upload before legacy upload; focusCurrent before focus; landing-set match before
   connect; SPA catch-all last). This is the net for every later step.
1. **BootConfig** (S/M): introduce the typed config; change `boot()` and `open/server.ts` in
   lockstep (the documented desync hazard); keep env mutation temporarily as a shim that
   *writes from* BootConfig so out-of-tree readers keep working; delete reads incrementally.
2. **Composer-contract barrel + boot-helpers split** (M): pure moves; the barrel re-exports
   everything currently reachable; snapshot-test the export names; audit the private repo
   before deleting anything (F3).
3. **Carve `open/composer.ts`** (L): extract along the existing section anchors into
   `open/wiring/{substrates,memory,uploads,http-shell,app-surfaces,onboarding,trident}.ts`,
   each returning a CompositionInput slice; convert the four holders into explicit
   `create()/bind()` two-phase seams; keep `prewarmSubstrate` semantics byte-identical
   (never-rejecting, not awaited at boot). The 30 open/__tests__ wiring tests + step-0 matrix
   are the lock.
4. **Data-driven surface registry** (M): generate the four lists from RouteSlot declarations;
   transition test asserts the generated ladder equals today's literal ladder, including the
   currently-diverged `hasAnyChainedSurface` (fix the divergence as an explicit, tested
   commit, not silently).
5. **One auth gate + landing route manifest** (M): name and test the Open gate; delete
   `LANDING_PATHS` in favor of the exported manifest; keep cookie-stitch semantics (append,
   never replace, both `authenticated` and `allow`).
6. **Unify credential resolvers; fix cycles; rename** (M): one precedence-table resolver with
   `allowAmbient`/`allowSharedEnvTier` flags; inject `agent-profile-backend` into
   `mountOpenCores`; move `ONBOARDING_HANDOFF_SKIP_FOR_NOW_VALUE` + `ChatCommandFilter` to
   neutral leaves; rename `realmode-composer/` → `gateway/wiring/` in the tenant-vocabulary
   pass (coordinated with the Managed repo, per F3).

### Load-bearing subtleties the migration must preserve (verified)

- `open/server.ts:58–73` env writes happen BEFORE `boot()`; boot re-reads env independently
  (gateway/index.ts:118–122, 147–157, 272, 308).
- Module registration order (`replToolBridge` after `mcp`, composition.ts:336–338);
  `cron.scheduler.start()` only after `graph.compose()` (:351–377); overlays before
  `buildComposedHttpFromComposition` (:383–415); same-object-reference mutation (:428–434).
- Shutdown order incl. `shutdownAllPersistentRepls` (gateway/index.ts:385–458); init-failure
  teardown both in boot() (:236–255) and composeProductionGraph (:413–426).
- Ladder semantics: authGate first with Set-Cookie stitch (:894–948); chunked-before-legacy
  upload (:1047–1072); per-project children before appProjects; landing path-set before
  connect; operator routes bypass the gate.
- Open gate: single-use `?start=` JTI claim (open/composer.ts:1638–1653); cookie minted only
  on first claim (:1737–1748); stale-cookie-over-wiped-DB cold-start (:1686–1690); React
  bootstrap injected by exact-string replace on the `/chat-react.js` tag (:1616–1626).
- Prewarm promise never rejects, is not awaited at boot (:3661–3684); `prewarmSettled`
  elevates cold-window timeouts (:508–521).
- Substrate instance-id prefixes are pool keys; trident fire substrate must stay warm
  per-repo-cwd (:590–633); only `cc-agent-` gets `enableToolBridge` (:535–541).
- Bun.serve selects the chained fetch per-request inside the serve arrow so the live server
  ref reaches WS upgrades (gateway/index.ts:309–323); `maxRequestBodySize` = import cap +
  64MB (:302).
- Holder fill-before-first-dispatch timing (open/composer.ts:654, 1329, 2183, 2321).

---

## 6. Corrections/nuances vs the subsystem maps

- map-boot-composition claims config is "re-read at runtime via loadInstanceEnvOverlay …
  per dispatch". In THIS repo `loadInstanceEnvOverlay` has **zero non-test consumers** — the
  per-dispatch re-read exists only in the private Managed composer. In Open, config is
  boot-frozen env. (Strengthens F3: another invisible-ABI export.)
- The `hasAnyChainedSurface` divergence reported by map-gateway-services is confirmed and is
  actually **four** fields, not three: `auth_gate` (composition.ts:254) is also mapped but
  absent from the gate — irrelevant for real composers (they set `landing_server`) but proof
  of the copy-machine failure mode.
- The Open composer's unwired-surface set (reminders/focus/admin/persona/devices/backups/
  launcher/connect-auth: zero production setters in-repo) has not been called out by any map
  as a *composition* consequence; it is the strongest concrete evidence for F6.
