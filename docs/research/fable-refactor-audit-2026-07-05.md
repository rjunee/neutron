# Fable Refactor Audit — Consolidated Action Report

**Generated:** 2026-07-05 by a 20-agent Fable workflow (`wf_33338335-1df`, 1.47M Fable tokens, 0 errors).
**Scope:** independent re-audit of merged deletions (K1–K9) + re-verification of K11's deletion claims + plan critique (waves 2–9).
**Status:** captured during a work-pause. On resume: fold §1 act-now items into fix units, restructure K11 per §2, apply §3 sequencing pins to STATUS/plan.

Per-agent raw results: `subagents/workflows/wf_33338335-1df/journal.jsonl` (session dir).

---

## 1. 🚨 Act-now (follow-up fix units for MERGED work + verified-LIVE K11 targets)

### A. Merged-work regressions (need fix units)

1. **[P2 · CONFIRMED behavior drift] K8 — retired `/code` sub-verbs bypass the friendly reject** — `gateway/boot-helpers.ts:641-642`. The `parsed.kind === 'unrecognized'` pre-check (added by *my* K8 Codex-fix) is BROADER than the canonical contract (`trident/code-command.ts:205` falls through only on `reason === 'not_a_code_command'`), so `/code status|review|merge|...` now go to the LLM instead of the reject — differential repro verified vs pre-K8. **Fix (S, one line + test):** narrow to `if (parsed.kind === 'unrecognized' && parsed.reason === 'not_a_code_command') return null`; add a seam pin in `gateway/__tests__/trident-code-command-wiring.test.ts` asserting `/code status` → claimed + reject text. (Also closes the K8 P3 lost-coverage — the deleted `chat-commands.test.ts` pin is exactly why this shipped green.) Reachability: live via the Managed gateway composition, not Open's composer — P2 not P1.

2. **[P2 · CONFIRMED lost coverage] K3 — import-resilience wiring traps deleted, not ported** — `gateway/realmode-composer/__tests__/build-import-resilience-wiring.test.ts` (deleted at 94c1155) carried BLOCKER #2/#3 pins on LIVE, unchanged wiring: default-built `ImportResumeReadinessProbe` (`build-landing-stack.ts:1081-1088`) + resume-handler mounting against shared runner/resolver/stateStore (`open/composer.ts:1427-1446`). Zero composer-level replacement on main. **Fix (S):** port tests against the surviving surface (`buildLandingStack`/`buildOnboardingEnginePieces` with `importUseSynthesis:true`; assert non-null probe + mounted resume POST + 404 on unknown job_id). Optionally add direct units for the relocated `import-payload-resolvers.ts` (317 LOC incl. SSRF guards, zero test refs).

3. **[P3] K3 — rate-limit exhaustion ceiling untested** — `engine-import-routing.ts:866-931, 1410-1476` retained, `MAX_RATE_LIMIT_RESUME_CYCLES` zero test hits (production-unreachable post-synthesis-cutover). **Fix:** restore the test, or schedule a unit deleting the unreachable `rate_limit_paused` machinery + `import-paused-auto-resume.test.ts` together. Fold into the K3 fix unit or the D9 brief.

### B. K11 targets VERIFIED LIVE — plan-blocking (details in §2)

4. **`engine-slug.ts` — plan claim "dead in both repos" is WRONG.** ~Half is the live open-mode agent-naming flow (`agent_name_chosen` live open-mode phase, `phase.ts:82,129-134`; open-mode advance branch at :182-217; suggestion machinery on live prompt-render path `engine.ts:7930`). Same failure class as K1/connect-accept.ts.
5. **`interaction-mode.ts` — servedByPath=TRUE.** 3 exports load-bearing for the KEPT import subsystem; `LATE_UPLOAD_SOURCE_MISMATCH_NOTICE` fires via live upload POST routes (`engine.ts:2246` via notifyImportUploadLocked), zero conversational involvement.
6. **`llm-router.ts` + `build-llm-router.ts` — each hosts a live half.** `buildGatewayAnthropicMessagesClient` (`build-llm-router.ts:280`) is THE production LLM client (`open/composer.ts:1108` fan-out + `build-landing-stack.ts:952` import-synthesis); `AnthropicMessagesClient` type feeds 3 live composers.
7. **`personality-character-suggester.ts` — `STATIC_PERSONALITY_CHARACTER_FALLBACK` (:215) is module-scope-imported by live `onboarding-preamble.ts:22`** (personality [[OPTIONS]] menu + per-turn step guard + button-backed capture).

---

## 2. ⚠️ Before K11 — deletion-list corrections

**K11's core premise VERIFIES** (conversational drive dead on every live path; D-5 trace holds). But restructure as **K11a (extractions + tests) → K11b (deletion)**, ideally separate PRs.

**Mandatory extractions (compile/live-break otherwise):**
1. **chat-bridge.ts:** excise ONLY the engine-drive inside `startSession`/`handleInbound`. `WebChatSenderRegistry` (:149), `webTopicId`, `renderButtonPromptForWeb`, `LiveAgentTurnRunner` types, `AppSocket*Router`, `WebChatSessionProjectRegistry` are all live. Extract `WebChatSenderRegistry` + `LiveAgentTurnRunner` types to a neutral module FIRST — this also resolves the K11↔D3 circular ordering (D3 is wave 5; pulling this slice forward is the plan's own named fallback).
2. **llm-router.ts / build-llm-router.ts:** move `AnthropicMessagesClient`/`AnthropicMessageResponse` types + `buildGatewayAnthropicMessagesClient` to a neutral module; repoint 5 type importers + `open/composer.ts:94,1108` + `build-landing-stack.ts:82,952`; move `build-llm-router-cc-substrate.test.ts` (pins an Argus BLOCKER: caller model override). Then unwire dead `buildGatewayLlmRouter` (`open/composer.ts:1127-1133,1294`).
3. **interaction-mode.ts → PARTIAL:** extract `IMPORT_SOURCE_SWITCH_ACK`, `LATE_UPLOAD_SOURCE_MISMATCH_NOTICE`, `detectImportSourceMention` into an import-subsystem leaf; migrate `source-switch-late-upload-race.test.ts` (only coverage of a live prod race — ISSUES #98). Then delete the ~500 conversational lines.
4. **personality-character-suggester.ts → PARTIAL:** extract `STATIC_PERSONALITY_CHARACTER_FALLBACK` + type shapes (home: onboarding-preamble.ts); keep `onboarding-preamble.test.ts`, `button-backed-answer.test.ts`, `personality-offered-character-buttons.test.ts` green.
5. **engine-slug.ts → SPLIT, not delete:** extract the open-live half (consumeAgentNameChosenChoice incl. :182-217, both suggestion getters, suggestionFingerprint/KeyPrefix, maybeAutoAdvancePastMaxOauthOffered — max_oauth_offered IS live in open mode); delete only the slug_chosen managed remainder (~500-600 net, not 1,086), gated on D-5/K4b. Keep `open-mode-phase-walk.test.ts` + `engine-agent-name-suggestion-wiring.test.ts` green.

**Retain inside the delete zone:** `work_interview_gap_fill` phase enum + legal transitions + consumeImportAnalysisPresentedChoice (live import watcher); engine.ts:268-298 hook-type re-exports (8 live importers); `agent-name-suggester.ts` (Managed ABI); `STATIC_PHASE_SPECS`/phase-prompts.ts + engine.ts:8143 static fallback (live LLM-less/failure path — the flag collapse means "remove the env gate," NOT "delete a copy source"); `LlmCallFn` export (5 live non-onboarding importers); `runtime/env-flag-tokens.ts`.

**Safe-to-delete confirmed, with paired edits:** `resume-cron.ts` (+ build-core-modules.ts:42-45/585-615, onboarding-input.ts:67, onboarding/index.ts:101-107); `NEUTRON_DEPLOYMENT_MODE` alias (MIGRATE — don't delete — the resolve-llm-credentials.test.ts:568-575 security pin to NEUTRON_ROLE; 30-sec prod grep of systemd units before merge); `landing.registry` instance (only AFTER the WebChatSenderRegistry type extraction; keep warn-log in routed-sender web: branches; rewire/co-delete WowChannelAdapter; do NOT touch webTopicId/history/topics surfaces — live grammar).

**Test re-anchoring gate:** the live import-subsystem integration tests (import-resume-button, import-hard-timeout-resilience, import-running-cron-*, import-analysis-presented, etc.) may harness through engine.start/advance — re-anchor them on notifyImportUpload/pollImportRunningTick/stateStore BEFORE the drive deletion, merged + green first (not same-PR).

**Gates:** root + leaf tsc, cross-package consumer tests (gateway/realmode-composer + open/), an exercised upload-route check, Managed vendored-tenant boot (requires M0).

---

## 3. 🗺️ Plan/sequencing risks (waves 2–9)

1. **M0 unmerged gates the C-wave** (all three lenses HIGH). C1/C2/C3 touch the 8 pinned open-contract.ts surfaces with no Managed CI to trip. **Dispatch M0 immediately** (S, lane managed, zero coupling); hard edges M0→C1 (+ K11 acceptance run), M1→C2/C4. Resolve the **C1 BootConfig vs ENV_READ_DIRS contradiction before dispatch** — a top-level `config/` leaf satisfies C1 but breaks the gate; home it under gateway/ or ship the M1 gate extension same-wave.
2. **Lane labels lie — compute file-intersection, not labels.** L2 ("lane none") touches engine/bridge/trident/transport and must hard-gate on K11 *merged* (not parked); L5 ("lane none") is a repo-wide write; L7 collides with W5 on chat-core. Pins: **K11 → L1 → L2 → L3 → C1** (L3(c) before C1 or folded — resolveOpenDbPath drift is a live-data hazard with no pinning test), **W5 → L7 → L6**; assign edge #4 (reminders/outbound.ts) to exactly one of L1/L2.
3. **Transport-lane priority inversion:** pin **S0 → W3a → W5 → L1 → L6**. The dev:owner hole + live half-open-socket fix must not queue behind mechanical extractions (S0 + W5 both touch app-ws-surface.ts). S0 additions: reconnect must re-fetch token on auth-reject; prefer per-INSTALL over per-boot; verify the Expo path.
4. **Stale evidence under L3's hard-error flip:** the 11-edge SCC cut list predates #178-#200 (PR #184 touched the mcp↔runtime cut #11 territory). Re-run depcruise SCC vs HEAD before L2/L3; L1's in-package staging (`landing/chat-protocol.ts`) makes its depcruise accept mechanically unverifiable — restate as grep-enforced or a sub-path rule.
5. **Anchor rot is now a per-unit MANDATORY gate, not one-time:** #197 rewrote the composer splice S0/C3c cite; #193 rewrote trident merge.ts (F6/F7/P10/K8 anchors); K11 shifts all D9a-d engine.ts ranges. Fable plan stage must re-grep every cited anchor and park-and-flag on mismatch.
6. **Trident self-surgery (K8-class, F4/F6/F7/P10):** these modify the machinery executing the window. Post-merge no-op canary; concurrency cap 1 while a trident-lane PR is between merge and canary-green; instant-revert readiness.
7. **W3 is the one true one-way door:** stage write-both → read-flip (G2 parity gate) → delete-after-multi-day-soak (three PRs); file-level DB backup before read-flip; if wave 9 runs late, ship write-both and defer the delete past the window.
8. **Wave-5 ordering:** P6 (paid-synthesis data-loss P0) FIRST in engine/data queues — consider pulling to wave 4; then RA1; D9a-d decompose around post-P6 code; P4→P11 last.
9. **Ralph/SPEC.md tripwire before K10:** add a CI/leak-gate rule failing any PR that adds root SPEC.md; land `resolveRalph:()=>false` in orchestrator dispatch before K10; K10 strictly after X6 + every parked/slipped unit merged-or-deferred.
10. **Smaller but real:** N4's rename map must carve out gate-pinned literals (healthz `project_slug`, NEUTRON_INSTANCE_SLUG) or move the ABI slice early while tenant-count==1; S3 needs a restore-drill + key-escrow acceptance line before excluding the AES key from backups; served-by-path/bundler-graph acceptance lines added to L6/D8/P8/C2; mark W8/F9/W0 done in §16 so the ready-set derives from §17.

---

## 4. ✅ Confirmed-clean

Phase A re-audited 8 merged K-units — **K1, K2, K4a, K5, K9 fully clean** (5/8); K3 + K8 clean except §1 findings (no live-break in K3; K8's drift is Managed-path-only). Phase B verified all 9 K11 target groups with served-by-path checks: 5 safe-to-delete-as-scoped (engine conversational clusters, resume-cron, deployment-mode alias, landing.registry, phase-flag pair), 4 requiring extraction-first (§2); confirmed K11's central deadness claim (engine.start/advance unreachable on every live path, /ws/chat gone). Phase C reviewed waves 2–9 through three lenses; the L-phase extraction topology itself is acyclic + band-consistent — all hazards are execution-layer (ordering, gates, stale anchors), not design.
