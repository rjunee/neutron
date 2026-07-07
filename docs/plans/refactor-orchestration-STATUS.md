# Refactor Orchestration — STATUS (resume anchor)

**Purpose:** the live state of the autonomous refactor window. Read this + the plan
(`docs/plans/2026-07-02-world-class-refactor-plan.md` §1.5 protocol, §17 checklist) at
the top of every orchestrator turn. This file is the single source of truth for "where
are we"; the plan is the source of truth for "what/how". Keep this file updated as units
land — it is what a fresh context reads to resume without re-deriving anything.

---

## Snapshot

- **Window state:** OPEN (kicked off 2026-07-03). All other work on these repos paused.
- **Driver:** this orchestrator session — Opus 4.8, `/effort high`, ultracode OFF.
  High-judgment/low-token: adjudicates diff-vs-acceptance, reconciles line-drift, ticks
  §17, merges. Building is delegated to per-unit worktree agents on routed models.
- **main HEAD:** `954779c` — **WAVE 0 COMPLETE** (G1–G10 + W0) + **WAVE 1 (K = kill / deletions):**
  K1,K2,K3,K4a,K5,K6,K7,K8,K9 merged. **✅ K11b1 DONE (the crown jewel — ~35k LOC of dead
  onboarding conversational-drive excised):** landed as THREE PRs — **#240 K11b0** (dead ChatBridge
  prerequisite), **#242 K11a6-completion** (re-anchor ~60 drive tests → survivors + DIE manifest),
  **#243 K11b1** (the deletion: engine drive methods + llm-router/interaction-mode/resume-cron/
  start-onboarding whole modules + §7.5 dual-site flag purge + ~70 DIE tests). Remaining: **K10**
  (docs cluster) + the **K11 TAIL** — D-K11-4 (`rate_limit_paused` rider), K11c (OAuth sources /
  D-K11-7), K11d (retained-but-dead prune: wow/final-handoff cluster + `engine-agent-name.ts` +
  suggestion branches + `consumeImportAnalysisPresentedChoice`), K11b2 (`NEUTRON_DEPLOYMENT_MODE`),
  K11b3 (web:-registry comment-truth). K4b deferred. **CI GREEN.**
  - **✅ K11b1 (#243, merged 2026-07-07):** coverage preserved by K8 rule, verified via **tsc
    ground-truth** (the K11a6 DIE manifest over-deleted the final-handoff family — tsc showed the 9
    builder tests compile; caught 4 survivors needing FIXES the manifest missed). **Codex caught 2
    real coverage-loss blockers** (round 1): the wow-push idempotency + final-handoff prompt
    contracts are reachable from the **retained** `emitCurrentPhasePrompt` auto-advance path
    (`max_oauth_offered` + Max attached) — NOT dead as the manifest assumed. Re-anchored onto that
    seam (`wow-push-autoadvance-survivor` + `final-handoff-render-survivor`, 19 tests incl. a
    credential-gate anti-self-fulfilling check) → Codex round-2 APPROVE. **⚠️ K11d must delete those
    2 survivors WITH the wow/final-handoff cluster prune.**
  - **✅ K11b0 (#240, merged 2026-07-06):** excised `buildWebChatBridge` + bridge-only helpers
    (chat-bridge.ts 2522→552 lines); re-pointed 4 live slug-compare sites onto `constantTimeEqual`
    (the anti-enumeration invariant, ISSUE #34, was previously enforced ONLY on the dead bridge —
    bridge deletion would have silently dropped it). **Fable liveness adjudication (2026-07-06):**
    bridge VERIFIED dead-in-prod (landing server reads `options.bridge` zero times, `/ws/chat`→404,
    every live client on `/ws/app/chat`); K11b0 behavior-preserving (`app-ws-surface.ts` untouched);
    Managed clean (vendors Open via `vendor/neutron` submodule, zero own-code refs to deleted
    symbols). Codex's 3 REQUEST_CHANGES findings all describe **pre-existing main drift**, not K11b0
    regressions → **filed as K11-F1** (engagement-mode unenforced on live app-ws + vestigial
    `runWithActiveProject`; user-reachable but NOT a security gap — resolver falls back to global).
  - **Window auxiliary units merged this batch:** FX1 #226 (`/code` pre-check narrow — audit
    caught the K8 over-broad reject), FX2 #227 (restore K3-deleted import-resume coverage,
    mutation-proven), RT1 #228 (Ralph/SPEC.md governed-mode tripwire — forces `ralph=false` +
    leak-gate bans root SPEC.md for the window; **K10 reverts both**), K11-pre #229 (re-anchor
    the 11 live import-integration tests off the doomed `engine.start`/`advance` — K11a6, no prod
    code touched). **M0** (Managed CI) = neutron-managed PR **#123** open (public submodule, no
    PAT); merges in the Managed repo.
  - **⚠️ K11 GATING — Fable deletion-claim sweep done (`docs/research/fable-k11-deletion-sweep-2026-07-06.md`).**
    Central premise (`engine.start`/`advance` dead on every live path) VERIFIED-DEAD; the 4 prior
    load-bearing targets re-confirmed. **7 NEW corrections folded into the plan/exec-plan as ⚠️
    callouts** — the critical one: K11b3's "delete `open/composer.ts:1926-2060`" pointed at LIVE
    reminders/brief delivery wiring (served-by-path trap); rescoped to a comment-truth pass. Plus
    4 missed paired-edits (D-K11-4 `rate_limit_paused` live route, §7.5 flag also in retained
    resolver, C2 barrel re-exports, D-K11-7 unowned OAuth purge). **Read those callouts before
    running any K11 sub-unit.**
  - **RESUMED (2026-07-06/07, autonomy grant):** K11a + K11a6-remainder + K11b0 + K11a6-completion
    + K11b1 all driven to merge (D-K11-1 cleared — Managed grepped clean, vendors Open via submodule).
    See [[neutron-open-k11b1-drive-deletion]] memory for the DIE-manifest≠tsc-ground-truth + Codex
    live-path lessons.
  - **K11 TAIL progress (2026-07-07):**
    - **✅ D-K11-4 RESOLVED → KEEP.** The `rate_limit_paused` / `attemptAutoResumeFromPaused`
      machinery is LIVE (auto-resume of a rate-limit-paused import via the retained
      `pollImportRunningTick` cron seam). `import-paused-auto-resume.test.ts` already survived K11b1
      anchored on the retained `buildImportRunningHandler` (3/3 green) — no code change; delete-together
      was the wrong branch (would kill live behavior + leave the 6 dangling status enumerators). Exec-plan §10 row marked resolved.
    - **⏸️ K11b2 DEFERRED — owner/OPS-gated (reasoning CORRECTED 2026-07-07).** In-source: NOTHING in
      current source sets `NEUTRON_DEPLOYMENT_MODE`/`NEUTRON_ROLE` (not the per-tenant provisioner
      `systemd.ts`, not `neutron-managed/src/` anywhere, not the live dogfood `.env`/plist). **⚠️ Earlier
      claim "managed-mode derived from the identity key" was WRONG:** `deployment-mode.ts` resolves mode
      purely from env (`NEUTRON_ROLE` > `NEUTRON_DEPLOYMENT_MODE` > `open`); the identity key only warns
      on misconfig + forces the narrow shared-projects-resolver. So the alias IS load-bearing for any box
      that sets it. The genuine residual = the live **Managed control-plane** unit (remote-VPS infra, in
      no repo). Removing the alias safely is a **2-step ops migration** (add `NEUTRON_ROLE=managed` to the
      live unit + deploy → then delete the alias read) — step 1 is against production infra, not safely
      doable headlessly. **Unblock:** Ryan confirms/migrates the live managed unit to `NEUTRON_ROLE`.
      Exec-plan §8 carries the full corrected banner.
    - **✅ K11b3 DONE-BY-VERIFICATION (no code change needed).** After K11b0 (bridge) + K11d
      (build-wow-dispatcher.ts) deletions, the unit is moot: `landing.registry` appears in `open/composer.ts`
      ONLY in 2 comments (:1875/:1966) that describe the legacy `web:` path in PAST tense ("were delivered…
      now fixed") — accurate historical rationale, NOT a stale falsehood; the registry instance itself lives
      on in `build-landing-stack.ts:607` (kept for import-progress/Managed); `registry.register(` has zero
      live sites in composer; the WowChannelAdapter rewire is moot (its file deleted in K11d). No dead code,
      no false comments → nothing to change. (Fable had already caught that the original "delete composer
      :1926-2060" scope pointed at LIVE reminders wiring.)
    - **✅ K11c DONE (#247, main green 2026-07-07):** dead OAuth import sources purged (`ImportSource`
      → `chatgpt-zip | claude-zip`), +32/−765. Resolves **D-K11-7 → (a) delete**. Codex r1 boundary
      fix (parser `default` arm / resume 409 `unsupported_source` / probe — migration 0040 CHECK still
      permits legacy `-oauth` strings). NOTE: auto-merge fired on required checks before the (non-required)
      full `test` check finished — harmless (main CI went green after) but **for tail units block on the
      `test` check explicitly, do NOT use `gh pr merge --auto`.**
    - **✅ K11d DONE (#248, main green 2026-07-07):** dead wow-push/final-handoff/max_oauth cluster
      deleted, **~12.7k LOC**. Verified DEAD 3 ways (audit + Fable + grep) — **corrects the #243
      "live-reachable" mislabel**: `emitCurrentPhasePrompt` was orphaned by #243's own dispatcher
      deletion (0 prod callers). The 2 #243 survivor tests deleted WITH the cluster. Codex r1: 2 contract-honesty
      fixes (dead deps on landing-stack/engine contracts) applied; the `max_oauth_offered`/`wow_fired`
      **phase-prompts "dead CTA" finding DECLINED as pre-existing** (K11d doesn't touch phase-prompts.ts;
      phases unreachable on main+branch; Fable confirmed behavior-preserving). Full trace in PR #248 comment.
    - **🆕 K11e FILED (follow-up, exec-plan §8b):** prune the orphaned `max_oauth_offered`/`wow_fired`/etc.
      phase DEFINITIONS (phase-prompts + enum + transitions). ⚠️ NOT data-only — `POST_MAX_OAUTH_PHASES`
      (`resolve-onboarding-phase.ts:47-48`) is LIVE creds-gate logic; legacy sqlite rows at these phase
      strings need a compat decision (served-by-path trap). Needs its own liveness pass; Managed-adjacent.
    - **Remaining autonomous tail:** K11e (phase-def prune, needs liveness pass), K11b3 (web:-registry
      comment-truth — WowChannelAdapter bullet now MOOT, deleted with build-wow-dispatcher.ts in K11d),
      K10 (docs cluster). K11b2 owner-gated (above).
  Leak-gate allowlists the tracked refactor docs (plan + STATUS + INVARIANTS, §1.4 / D-11).
- **Recurring CI flake to watch:** `Argus r2 … concurrent write+delete on same path keeps
  anchor live` fails intermittently on the throttled runner (hit twice this window; clears on
  job re-run, 31/31 local). Not a unit defect — a candidate for test hardening / quarantine.
- **Chat-react async-leak flake (FIXED #222):** `WorkBoardTab.tsx:330` fired setState in async
  continuations after unmount → CI chunk-7 crash `ReferenceError: window is not defined`. Root fix
  merged **#222** (`aliveRef` guard on all 9 async→setState sites + a repro test). Wave-1+ CI
  stopped hitting it.
  **G5 landed a structural CI change:** the Typecheck step is now a MATRIX
  (`scripts/ci/typecheck-all.sh` runs `tsc -p` over all 44 tsconfigs; DOM stripped from
  server configs). Every subsequent unit MUST pass `bash scripts/ci/typecheck-all.sh` on
  rebase, not just root+leaf tsc.
- **CI infra:** `.github/workflows/ci.yml` throttled to `NEUTRON_TEST_CONCURRENCY=2`,
  `CHUNK_SIZE=75` (conservative guaranteed-green; ~2× wall-clock). Raise / set
  `NEUTRON_TEST_JOBS>1` once a faster runner is wired. Runner-upgrade decision PENDING
  (see [[neutron-open-ci-baseline-git-identity]] — personal repo → no hosted larger
  runners; realistic path = self-hosted runner on Ryan's Mac, needs his ~3-min reg).

## Done

- **CI baseline repair** (#195, `41b57c0`) — real-git trident tests needed a repo-local
  git identity on Linux CI (was masquerading as OOM). main green.
- **F9** (#194, `00bd398`) — `[BEHAVIOR]` trident conflict-resolver tools + humanized
  delivery + REAL passthrough test. **Orchestration PILOT** — proved the full machine:
  worktree build-agent → Argus/Codex review → CI green → squash-merge. §17 ticked.
- **Leak-gate main-red repair** (#198, `5e96e15`) — #196 committed the tracked plan doc
  WITHOUT its leak-gate allowlist entry (§1.4 / D-11) → Purity gate flagged 34 `tenant-*`
  hits and main's `ci` push workflow was RED on every push since (STATUS "baseline GREEN"
  was stale). Fix = allowlist the plan doc for retired-vocab rules only (mirrors
  AS_BUILT.md); PII/hosted-domain/secret rules stay armed. Unblocked the whole window.
- **W8** (chat client cheap wins · `sonnet` · lane clients) — **#197, `89728c2`**, §17
  ticked. 4 items: (a) `[BEHAVIOR]` cache-busting `/chat-react.js` (#353) — escalated by
  Codex across r1-r3 from ETag-only to airtight **URL versioning** (`?v=<content-hash>` in
  shell + `no-store` + resolve-before-serve); (b) desktop theme toggle restore (#360);
  (c) `.car-md` list spacing (#358); (d) code-block copy button (#359). 6 review rounds →
  Codex APPROVE. **Two CI-caught issues** (both real, both lessons): (1) the `?v=` rewrite
  broke `open/composer.ts` bootstrap injection — cross-package consumer I'd missed locally
  → [[refactor-orchestrator-gate-crosspackage]]; (2) the leak-gate main-red above surfaced
  once an anchor-walker timing flake cleared. Airtight cache-busting is the real #353 win.
- **W7-crash** (#354 blank-screen crash · `opus` · lane clients) — **RESOLVED-by-batch-PRs;
  guard = #200, `135c2e1`.** The opus agent REFUTED the crash as already-fixed at HEAD:
  the load-bearing memo (assistant-ui adapter identity → `setAdapter` early-return) landed
  in **PR #162**, predating the jank report; the LIVE crash was a **stale cached bundle**
  replaying pre-#162 code, now closed by W8's #197 cache-busting. #200 adds a zero-behavior
  extraction (`useChatAdapter`) + a **discriminating** regression test (fails if the memo
  is removed) + pane-switch coverage. Codex APPROVE; root+leaf tsc + 334 chat-react + 5
  open tests pass. **Browser-verify is Ryan's manual gate** (PR #200 body: hard-refresh,
  switch ~10× with Work pane open during a live build → DOM survives, zero console errors).
  §17 W7 stays UNCHECKED — the full mount rebuild (#355 re-slide, #356 typing) is wave-7 W7.

**✅ STEP 0 (Wave −1) COMPLETE** — F9 #194, W8 #197, W7-crash #200. Plus main-red repair #198,
docs #199. main GREEN @ `135c2e1`.

## Wave 0 (Phase-0 guardrails) — COMPLETE (10/10 + W0; M0 cross-repo deferred)

**Merged:**
- **G5** (#204, `b38b2f2`) — typecheck-completeness MATRIX + DOM-strip; 47 masked type
  errors fixed (incl. a real jwt-validator bug). Codex APPROVE. The high-value guardrail.
- **G1** (#203) — Open route-matrix characterization (ladder + negative space, both
  directions). **Surfaced a latent prod bug**: `hasAnyChainedSurface` omits
  `import_resume_handler` → a resume-only composition serves nothing; pinned as a
  documented known-divergence for a later fix unit.
- **G10** (#202) — `docs/INVARIANTS.md`, 111 anchored invariants (108 unit-protected,
  3 review-only). Allowlisted for retired-vocab.
- **G6** (#206) — substrate error-string classifier conformance (6 classifiers pinned by
  driving the REAL producer strings per the no-mock rule; tripwire proven on reword).
- **G3** (#205) — mirror parity (TabDescriptor, AgentEngagementMode) + entity-format golden
  round-trip. Bidirectional parity via typed-parameter identity fns (catches either-side widening).
- **G7** (#208, `8eae26f`) — leak-gate NUL tripwire (`binary-hidden` rule, fail-closed) +
  retire 3 raw-NUL tokens as `\x00` escapes (**byte-identical**, hash-stability golden).
  Codex REQUEST_CHANGES **DECLINED** (documented): the composite-key collision it flagged
  (`${emoji}\x00${device_id}` etc.) is PRE-EXISTING (raw-NUL delimiter before, identical
  `\x00` after) and out of scope for a byte-identical unit — **pinned as a known-divergence**
  (see below) like G1's `hasAnyChainedSurface`.
- **G2** (#211, `66a0df3`) — hydration-parity 3-transcript fidelity matrix (HTTP history /
  WS resume / live push), divergence PINNED as green-today (W3 flips DROPPED→PRESENT). Real
  seam driven (one SQLite ProjectDb, real ButtonStore + AppWsAdapter). Codex APPROVE (clean).
  Root cause noted: `AppChatRow`/`button_prompts` have no columns for citations/doc_refs →
  W3 needs schema work, not a mapping fix.
- **G9** (#209, `b7c4c1c`) — shared test-isolation testkit (`createIsolatedHome` +
  `reserveFreePort`), adopted in 3 polluting suites (pass twice consecutively). Codex found
  FOUR real env-leaks in the testkit's OWN suite across rounds (LIFO restore order,
  noUncheckedIndexedAccess, ambient-key destruction) — all fixed; final fix is a file-level
  full-env snapshot/restore so the suite can never leak. Codex APPROVE.

**G4** (#210, `92cf3c7`) — dependency-cruiser five-band layering gate + 21-edge grandfathered baseline + CI gate. Two Codex rounds (r1: 3 rule-correctness gaps — tests invisible to no-cycles, static composition→connect, direct-only app-purity; r2: ratchet-growth + self-tests, ROUTED to G8). Merged on met acceptance.
- **G8** (#213, `b3bdc63`) — self-tests for run-tests.sh + leak-gate.sh + a CI-enforced depcruise **ratchet-growth guard** (baseline may only shrink vs main). Loud-fatal empty BUN_DISC (override documented). Codex REQUEST_CHANGES (run-tests fatal breaks CI) was a FALSE POSITIVE — empirically BUN_DISC=915 on local AND CI (Codex mis-reproduced with explicit file args vs the script's no-arg full discovery). Separately fixed a real leak-gate-selftest literal-token issue my clean-export re-run caught. Merged.

**Wave-0 remaining:** only M0 (Managed CI — cross-repo neutron-managed, deferred).

## Wave 1 (K = kill / deletions) — merged

- **K1** (#217, `557bdd0`) — delete dead `landing/connect` files + split `escapeHtml` live.
  **Codex near-live-break catch:** the plan's audit wrongly marked live `connect-accept.ts`
  dead (confused with the removed orphan `connect-accept-server.ts`); restored the live trio.
  Lesson → [[refactor-deletion-served-by-path-trap]]. (Plan §K1 corrected in-doc.)
- **K2** (#215, `44cbf1f`) — delete dead slug-picker from `chat-bridge.ts` (~510 LOC).
- **K3** (#216, `94c1155`) — evacuate + delete the dead per-chunk import pipeline (−5k+ LOC).
- **K4a** (#219, `6dd6761`) — delete dead `acceptChoice` (0 prod callers) + pin phase_state
  contract. K4b (slug-flow) deferred. **Known-divergence pinned:** `__cancel__` advances signup
  (see below).
- **K5** (#218, `274ff21`) — misc kill-list sweep (dtc + X5-gated items preserved).
- **K8** (#221, `53b2844`) — delete Trident v1 remnants + retired code-gen forks (~−4.3k LOC);
  FIX 9 parity retargeted onto live `inner-workflow.mjs`. Codex found 2 real issues (both
  fixed): the `/codefoo` gateway-grammar boundary + a stale `codegen_dispatch` MCP manifest.
- **K9** (#220, `79396a1`) — delete orphaned `router-thinking-budget` (0 callers) + make the
  substrate/AGENTS comments honest (the `MAX_THINKING_TOKENS=0`/`extra_env` guard was never
  wired). Codex caught a missed AGENTS.md doc-drift (fixed).

Net wave-1 so far: **~−17.7k LOC** removed behind green gates. Every unit's Codex review found
≥1 real issue; zero regressions shipped; zero owner-stops triggered.

## Known-divergences (pinned by a guardrail, owned by a later fix unit)

- **G1:** `hasAnyChainedSurface` (`gateway/composition.ts`) omits `import_resume_handler` →
  a resume-only composition serves nothing. Pinned by G1's route-matrix test.
- **G7:** composite-key encoders use a NUL delimiter (`parseReactions`, in-mem calendar,
  `InMemoryOnboardingStateStore`, doc-search per-file collapse) → a component containing NUL
  collides. Pre-existing (byte-identical through G7). Low severity (needs literal NUL in
  emoji/slug/id). Owner: a later fix unit adds collision-proof keying + boundary tests.
- **K4:** `__cancel__` (a NON_ADVANCING sentinel, but NOT in the gateway's
  `FORBIDDEN_INBOUND_VALUES` = {`__freeform__`,`__timeout__`}) reaches `advance → consumeChoice`
  on the signup prompt and WRONGLY advances signup — the signup generic route has no
  NON_ADVANCING guard (the surviving guards are only in `consumeWowFallbackChoice` +
  `handleFinalHandoffOnCompleted`). Pre-existing: the deleted `acceptChoice`'s guard sat on a
  dead path, so live behavior is identical pre/post-K4. Pinned by a characterization test in
  `engine-advance-choice-parity.test.ts` (asserts current buggy `advanced`; flip to
  `no_active_prompt` + phase `signup` in the fix unit). Owner: a later onboarding fix unit / K11.

**Review pattern (holding across every unit):** build agent → orchestrator diff review → Codex
cross-review (EVERY unit found ≥1 real defect: vacuous assertions, one-directional parity holes,
wrong anchors, boundary gaps, a clipboard sync-throw, the composer-injection regression, a latent
composition bug) → fix-loop → rebase onto main + `typecheck-all.sh` → CI green → squash-merge.

## Ready-set / queue (order: waves 1–9; K10 LAST)

**Wave 1 remaining:**
1. **#222** (live-fix, Codex APPROVE, CI pending) — WorkBoardTab unmount-guard flake fix
   (lane clients). Merge on green.
2. **K6 / K7 / K10** — docs cluster, all **lane docs → SERIALIZE**. Orchestrator-managed:
   K7 `git add`s untracked plans/research docs that live only in the MAIN tree (a fresh
   worktree can't see them). K10 (public root `SPEC.md`) sequenced **LAST** — D-4 governed-mode
   landmine (`detectRalphMode` triggers on SPEC.md existence; git-mode.ts:100-142). Order:
   K7 (truth pass + git-add) → K6 (changelog consolidation) → K10 (SPEC.md).
3. **K11** — one onboarding flow + flag purge (`opus`, lane engine, ~−5-6k LOC). BLOCKED on
   the chat-bridge sender-registry split (D3) — do K11 after/with it, or extract the
   `WebChatSenderRegistry` first. Overlaps K4b. **Highest-risk remaining unit.**

**Then waves 2–9** (L layering → C → D → P → O → X → W → M → N → S) per the §16 wave table.
Do NOT start wave 2 (L1 chat-protocol extraction) until K11 lands — L1 must not extract code
K11 removes.

## Protocol (full detail in plan §1.5)

- **Per unit:** one isolated-worktree build → PR, self-driven (no Vajra fleet-chat dep).
  Model routing: **Fable 5** plans/synthesizes the hard units; **routed build** model per
  the unit's `model` column (opus = judgment, sonnet = recipe-mechanical, haiku = pure
  sweep); **Argus review never weaker than Sonnet**; **Codex reviews EVERY unit**.
- **Orchestrator does synthesis itself:** verify diff-vs-acceptance + run Phase-0 guardrail
  suites (once they exist) + tick §17 + AS_BUILT note, then merge (squash, delete branch).
- **Ready-set:** a unit is ready when its deps are merged AND its lane is free.
  **Concurrency cap 3.** Distinct lanes only.
- **Failure ladder:** 2 build attempts → bump model tier → park the unit (never blocks
  independents). Treat empty/zero-tool agent returns as spawn flakes → auto-retry.
- **`bun install` after any main-merge before trusting tsc.** Verify trident via
  `tsc -p trident/tsconfig.json` (root tsc misses errors).

## STOP-for-owner ONLY on (else stay autonomous to completion)

1. Unresolved scope/behavior decision not already settled in the plan.
2. Irreversible-beyond-a-unit-PR: force-push to main, data loss, or a Managed-contract
   break (the 8-surface `open-contract.ts` process contract).
3. Systemic failure: ≥3 units failing on the same root cause.

## Pointers

- Plan: `docs/plans/2026-07-02-world-class-refactor-plan.md` (§1.5 protocol, §16 waves,
  §17 checklist, §14.6 Phase R memory).
- Audit findings: `docs/research/refactor-audit-2026-07-02/verified-findings.json`.
- Memory: [[neutron-open-refactor-plan]], [[neutron-0703-dogfood-handoff-refactor]],
  [[neutron-open-ci-baseline-git-identity]], [[neutron-memory-perfect-recall-gap]].
