# Fable K11 + whole-plan deletion-claim sweep — 2026-07-06

**Model:** claude-fable-5 (adversarial, read-only). **Baseline:** `main @ fd814d9` (= K11 plan baseline; origin/main was +2 = FX1 `/code` pre-check + K6 docs, neither touches any target below). **Prompt mandate:** hunt the "unverified assumption stated as fact, then built upon" class — specifically wrong deletion/dead-code claims that fall into the *served-by-path trap* (a file with zero static importers still reached via route/URL, registry, dynamic import, config/JSON, or entrypoint). Re-derive independently; do NOT trust the prior audit (`fable-refactor-audit-2026-07-05.md`).

This sweep exists because we shipped this exact class of error twice (K1 `connect-accept.ts` marked dead but live; a prior audit found 4 load-bearing K11 targets on the delete list) — and, low-stakes, I asserted rjunee/neutron was private without a 5-second check. The point of the sweep: prove liveness with commands, don't assert it.

---

## Headline

- **Central K11 premise VERIFIED-DEAD:** `engine.start`/`engine.advance` are dead on every *live* path (the web-chat bridge that calls them is unmounted — constructed at `build-landing-stack.ts:1317` but zero readers of the returned `.bridge`; `/ws/chat` upgrade removed → 404; websocket `open()` is a close-1011 stub). This validates the whole K11 excision **and** K11-pre (#229), whose re-anchoring rests on it.
- **The 4 prior-audit load-bearing targets re-confirmed independently** (llm-router / build-llm-router live halves incl. THE production LLM client `buildGatewayAnthropicMessagesClient`; interaction-mode's 3 live exports; engine-slug's live open half; personality-character-suggester's live wiring). The exec plan's split/retain corrections for these are right.
- **7 NEW findings the prior audit missed** — one critical (a delete anchor pointing at live code), the rest missed paired-edits. See §3.

---

## 1. K11 verdict table (every delete/move/dead claim, re-verified)

| path / claim | plan claim | VERDICT | evidence |
|---|---|---|---|
| **`engine.start`/`engine.advance` dead on every live path** | dead (D-5) | **VERIFIED-DEAD** | non-test `engine.start` callers: only `gateway/http/chat-bridge.ts:1292` + `onboarding/api/start-onboarding.ts:36`; `engine.advance`: only `chat-bridge.ts:1900,1954` + `resume-cron.ts:236`. Bridge unmounted: `buildWebChatBridge` built only at `build-landing-stack.ts:1317`, `grep "stack.bridge"`=0; `/ws/chat` upgrade removed (`landing/server.ts:1593-1601`→404; ws `open()` close-1011 stub); `.startSession(`/`.handleInbound(` zero non-test callers. `open/composer.ts` has NO real `engine.start` (only stale comments :1197/:1451/:1487 — §7.7 fixes) |
| `onboarding/api/start-onboarding.ts` (D-K11-1) | unresolved: grep Managed | **VERIFIED-DEAD → co-delete** | Open: only its own barrel `onboarding/index.ts:190-194`. Managed: `grep handleStartOnboarding` hits ONLY `vendor/neutron/**` copies; Managed src/tests/scripts=0 |
| `onboarding/interview/llm-router.ts` (K11b1 delete post-extraction) | dead except types | **deletion-as-scoped VERIFIED** | live halves: `AnthropicMessagesClient` type → `build-project-{doc,kickoff}-composer.ts`, `build-project-opening-message.ts:50`; `PhaseKnowledgePack` → retained `phase-spec-resolver.ts:47`. Rest reachable only via doomed engine methods |
| `gateway/realmode-composer/build-llm-router.ts` | delete husk post-extract | **live half carved out correctly** | `buildGatewayAnthropicMessagesClient` = THE prod client: `open/composer.ts:94,1108` + `build-landing-stack.ts:82,952`. Dead half `buildGatewayLlmRouter` built at `composer.ts:1129` but product fires only in doomed methods (engine :2584/:2715/:2724/:6909) |
| `onboarding/interview/interaction-mode.ts` (delete remainder) | 3 exports servedByPath; rest dies | **VERIFIED as scoped** | 3 non-test importers only: `engine.ts:146-153`, `engine-import-routing.ts:34-35`, `engine-internals.ts:63`. Dying symbols used only in doomed methods |
| `onboarding/interview/resume-cron.ts` | safe-delete, dead-configured | **VERIFIED-DEAD** | `onboarding_resume_cron` read at `build-core-modules.ts:588` but passed by nobody (`composer.ts`=0). Managed runs stock vendored composer |
| `onboarding/interview/fixture-anthropic-client.ts` | delete | **VERIFIED-DEAD post-K11b1** | sole non-test importer `build-llm-router.ts:43`; env gate `NEUTRON_E2E_LLM_FIXTURES_DIR` set by no script/CI |
| `runtime/onboarding-conversational-flag.ts` | delete + accessor | **VERIFIED-DEAD** | sole non-test importer `runtime/platform-adapter-local.ts:64` (the paired hard-pin) |
| engine methods start:686/advance:1721/normalAdvance:2412/dispatchRouterDecision:3038/consumeChoice:3817/shouldConsultRouter:2819 | delete by symbol | **anchors exact @ fd814d9** | all six re-grepped exact; `consumeChoice` external callers=0. Retained surface live: `notifyImportUpload` @ `composer.ts:1347-1349`, `pollImportRunningTick` cron @ `build-core-modules.ts:621` |
| `onboarding/interview/engine-slug.ts` — orig plan "1,086 dead in both repos" | **plan WRONG; exec-plan SPLIT right** | **STILL-LIVE (half)** | `agent_name_chosen` live open-mode phase: `phase.ts:82-83,92,129+`; wired via `engine-internals.ts:2126/2218/2225`, `engine-persona.ts:323`, `engine.ts:335-337,4114,5844` |
| `personality-character-suggester.ts` — orig plan in delete list | **plan WRONG; K11a4 RETAIN right** | **STILL-LIVE** | `composer.ts:127` import + `:1113` live wiring; `onboarding-preamble.ts:22,40-41`; `build-landing-stack.ts:668` |
| `NEUTRON_DEPLOYMENT_MODE` alias (K11b2) | removable | **VERIFIED local; remote UNCERTAIN** | read only `gateway/deployment-mode.ts:40,55+`. Managed sets neither it nor `NEUTRON_ROLE`; local plist/.env/launchctl=0. Hosted systemd not reachable → owner pre-merge grep stands |
| legacy `web:` registry (K11b3) | dead | **VERIFIED dead — but composer ANCHOR WRONG (§3 N1)** | 4 `registry.register(` sites all in dead bridge; but `landing.registry` in `composer.ts` is COMMENTS only (:1940,:2031) — no deletable branches at cited :1926-2060 |
| Router timeout envs + `router_decision` telemetry | die with router | **VERIFIED** | `NEUTRON_ROUTER_{HAIKU,SONNET,FIRST_TURN}_TIMEOUT_MS` read only `llm-router.ts:363-377`; `RouterTelemetryEvent` only llm-router + `event-emitter.ts:67,100,383` |
| `rate_limit_paused` machinery (D-K11-4) | prod-unreachable | **VERIFIED unreachable-to-ENTER — one unlisted paired edit (§3 N2)** | no live writer sets it; but live resume route lists it: `gateway/upload/import-resume-handler.ts:55` `RESUMABLE_STATUSES` |
| K11a1 (`WebChatSenderRegistry`:149, `LiveAgentTurnRunner`:309, 6 importers) | move | **VERIFIED** | anchors exact; `reminders/outbound.ts:25` type import spot-checked |
| K11a6 test triage (17-file census) | A/B/C | **VERIFIED census; 2 stale (§3 N6)** | exactly 17 files call `.start({`/`.advance({`; all covered; list-A `import-running-cron-scheduler-boot` + `import-paused-auto-resume` have ZERO drive calls (over-inclusion, conservative) |

## 2. Rest-of-plan findings

| unit | claim | VERDICT | evidence |
|---|---|---|---|
| **C2** | 8 boot-helpers exports + `loadInstanceEnvOverlay` dead | **VERIFIED-DEAD + unnamed co-delete (§3 N4)** | each has ONE non-test ref: barrel `gateway/index.ts:33-53` (no use in `boot()`); Managed=0. Those re-export lines must die same-PR |
| **M2** | `NEUTRON_GRAPH_COMPOSER_MODULE` dead, delete loader `gateway/index.ts:500-587` | **VERIFIED local; remote UNCERTAIN** | read `gateway/index.ts:543`; Managed hit is a comment only (`src/ops/open-contract.ts:35`); local clean; remote systemd caveat |
| **D8** | landing/server dead fns + `SocketState:846-934` + unread bridge | **3 fns + bridge VERIFIED-DEAD; SocketState UNCERTAIN (§3 N7)** | `validateActiveTopicId:77`/`resolveRequestHost:111`/`emitSessionReady:124` defs w/ zero callsites; `SocketState` type-referenced by LIVE handlers `landing/server.ts:945-946` → retype needed |
| **X3** | `core-sdk/validator.ts` zero prod callers | **VERIFIED-DEAD** | `validateNeutronManifest` outside core-sdk only in comments; barrel `core-sdk/index.ts:48` no consumer |
| **RA4** | doc-search embedder seam dead | **VERIFIED** | `composer.ts:813` builds `DocSearchRuntime` w/o embedder; seam optional |
| **F2/D-7** | `ProjectBackupScheduler` + `AgentWatcher` never run | **VERIFIED** | both defined (`project-backup-scheduler.ts:85`, `agent-watcher.ts:265`) zero construction sites |
| **N7** | ghost `scripts/**` refs | **VERIFIED** | `boot-helpers.ts:205` points at non-existent `scripts/install/regenerate-owner-slug-dropin.sh` |
| **M6** | `neutron-managed-contract` stale worktree | **VERIFIED** | registered worktree of neutron-managed (branch `managed-contract-gate` @ 9252e63) |
| K11 "dead OAuth import sources" | purge | **plausibly dead but UNOWNED (§3 N5)** | gmail/calendar/drive/notion/slack-oauth = type members + switch arms, no live payload-resolver; not scheduled in any K11 sub-unit |
| C5/L6/W1/W4/W3/S2c/N6/M5 | various | listed for coverage — all transition-tested/parity-gated/flagged decision units, no bare-deadness risk | plan carries its own gates |

## 3. NEW wrong/incomplete claims (prior audit did NOT list these)

1. **[CRITICAL] K11b3's composer deletion anchor points at LIVE code.** Exec plan: "Remove Open's dead legacy `web:`-delivery branches (`open/composer.ts:1926-2060`)". Reality: `landing.registry` occurs there in **comments only** (:1940,:2031); :1926-2060 is the **live** reminders + morning-brief delivery wiring — `appWsAgentPushRegistry` (:1963-1971), `reminder_dispatcher` (:2003+), `proactiveSink` (:2036+). Executing the delete literally = deleting live reminder/brief delivery. The real remaining web:-legacy is in chat-bridge's routed senders (:622/:652), which the SAME unit says to KEEP. → **Restate K11b3 composer scope as a comment-truth pass only.**
2. **D-K11-4 delete option misses a live-route paired edit.** `gateway/upload/import-resume-handler.ts:55` `RESUMABLE_STATUSES` includes `'rate_limit_paused'`. Same-PR sweep also needs: `landing/server.ts:487`, `chat-bridge.ts:604`, `channels/adapters/app-ws/envelope.ts:554`, `history-import/types.ts:43`, `phase-prompts.ts:2042`.
3. **§7.5 flag purge incomplete.** `NEUTRON_LLM_ONBOARDING_PHASES/_DEFAULT` is also read in the **retained** `onboarding/interview/phase-spec-resolver.ts:2007-2067`. Deleting only the build-side gate leaves live env reads → violates "zero feature-flag branches".
4. **C2 must co-delete `gateway/index.ts:33-53` barrel re-exports** of the 8 dead helpers (unit text mentions only boot-helpers.ts). Compile-caught, but gateway/index.ts is Managed-contract-pinned → warrants the M3-rider check.
5. **"Dead OAuth import sources" purge was silently dropped from the exec plan** — no sub-unit owns it. Re-add (paired edits: `engine-internals.ts:1627-1631`, `engine-import-routing.ts:1191`, `history-import/types.ts:16-20`, `oauth-calendar.ts`) or record the deferral.
6. **K11a6 list-A stale classifications** (minor, conservative): `import-running-cron-scheduler-boot.test.ts` + `import-paused-auto-resume.test.ts` have no `.start({`/`.advance({` — already anchored, need no re-anchor. (Matches K11-pre #229's "verified-already-safe" disposition.)
7. **D8's `SocketState` is not zero-referenced** (minor): live type positions `landing/server.ts:945-946`; delete needs retype of live `fetch`/`websocket` handler signatures.

## 4. Coverage gaps

- **Remote/hosted systemd units** for `NEUTRON_DEPLOYMENT_MODE=` / `NEUTRON_GRAPH_COMPOSER_MODULE=` not greppable from this machine (local launchd + `~/neutron/.env` verified clean). K11b2/M2 owner pre-merge grep remains mandatory.
- **WowChannelAdapter web-delivery liveness** (K11b3 rewire-or-co-delete) needs a runtime trace — statically indeterminate. Possible pre-existing live bug: if wow durable rows land under `web:<user>` topics they may be invisible to the app-ws client today. Worth a dispatch-time look.
- **Dying-suite pinned-behavior porting** (§7.4 per-file judgments) is inherently dispatch-time.
- Merged K1–K5/K8/K9 not re-audited here (prior audit Phase A covered them; K1 corrected in-plan).
