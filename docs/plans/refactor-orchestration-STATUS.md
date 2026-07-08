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
- **main HEAD:** `8d9c141` (C3a #272 merged 2026-07-08; first `open/composer.ts` wiring carve → `open/wiring/{context,substrates,memory}.ts`, verbatim, prewarm live-ref + cleanups preserved) — **WAVE 0 COMPLETE** (G1–G10 + W0) + **WAVE 1 (K = kill / deletions):**
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
    - **✅ K11b2 DONE (#257, merged 2026-07-08) — OWNER-APPROVED DELETE.** Ryan delegated the call
      2026-07-08 ("if you can't find it in either repo, safe to delete — make the call"). Re-verified
      exhaustively: every `NEUTRON_DEPLOYMENT_MODE` hit is a test fixture / vendored test; the Managed
      provisioner (`provision-hetzner.sh`, `neutron-service.sh`, `install.sh`, `.env.example`) sets NEITHER
      `NEUTRON_ROLE` NOR the alias → removal is behavior-preserving. Alias branch deleted; `NEUTRON_ROLE`
      is the sole mode key. **Codex 5 rounds** — my first pass added a `console.error` tombstone; Codex
      correctly called it *worse than a clean delete* (logs but still resolves `open`, so the credential
      boundary is unchanged — a false protection) + confirmed NO implemented boot tripwire → reverted to a
      **clean delete** with the accepted trade-off documented plainly (alias-only box → `open` → could use
      the shared env key; no such box exists; sole residual = untracked hand-set VPS env, owner-accepted).
      r3/r4 strengthened the boundary test + caught a real `TS2345`. Security pin (`NEUTRON_ROLE=managed`
      refuses shared key) preserved. Exec-plan §8 rewritten to DONE. **K11 tail now FULLY closed** (only
      K10 remains, wave 9).
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
    - **✅ K11e DONE (#251, main `f27c66c` 2026-07-08):** pruned the orphaned `max_oauth_offered`/
      `wow_fired` phase DEFINITIONS (union + `LEGAL_TRANSITIONS` + `ALL_PHASES` + phase-prompts +
      resolver packs), net −465 LOC. **Served-by-path trap handled atomically:** `POST_MAX_OAUTH_PHASES`
      widened `ReadonlySet<OnboardingPhase>`→`ReadonlySet<string>` keeping the legacy literals verbatim +
      `loadCurrentOnboardingPhase` returns the RAW DB string, so stranded pre-#243 legacy `onboarding_state`
      rows still classify as post-max at the creds gate (new stranded-`wow_fired` compat test proves it).
      `persona_reviewed` forward chain collapsed → `completed`. **Codex 3 rounds:** r1 blocker (persona_reviewed
      LLM guidance still NAMING the deleted phases — injected goal + tangent-answer FAQs, a user-visible lie
      at the final checkpoint) FIXED; r2 two more stale refs (advance_examples summary + enum doc-comments)
      FIXED + guard broadened to deep-scan the pack; r3 re-raise **DECLINED** (see known-divergence). Verified:
      root tsc + 44-config matrix clean, 895 onboarding/gateway tests / 0 fail, full `test` check green.
    - **Remaining autonomous tail:** **K10** (docs cluster, sequenced LAST — Ralph governed-mode landmine).
      K11b2 owner-gated (above). [✅ K11c #247, K11d #248, K11e #251, K11b3 done-by-verification, D-K11-4 KEEP]
      → K11 is functionally COMPLETE modulo the owner-gated K11b2; **Wave 1 closed, Wave 2 (L-layering) OPEN
      now** (K10 stays sequenced last, wave 9 — Ralph landmine).

## Wave 2 (L layering → C → W5 → M1/M2) — IN PROGRESS

- **✅ L1 DONE (#253, main `39a44b2` 2026-07-08):** chat-protocol wire types (`ChatOutbound` + its 10
  `*Outbound` member interfaces) extracted VERBATIM (JSDoc byte-identical — verified via diff) out of
  the `landing/server.ts` edge module into the new leaf `landing/chat-protocol.ts`; `server.ts` keeps a
  re-export barrel (+ a local `import type` for its own `emitSessionReady` signature). 7 PRODUCTION
  importers flipped to the leaf (gateway/open/reminders — the real inbound edges cut); test-file importers
  left on the barrel per §2.2 (L5 sweep rewrites them). Scope narrowed: `ChatInbound`/`PendingChatClaim`/
  `ChatBridge` were already dead (excised in K11b0). Codex found NO code regression; its 2 "blockers" were
  STATUS.md base-staleness (branch predated #252) → resolved by rebase onto current main. Matrix 44/44,
  landing+gateway 2638 / reminders+open green, depcruise clean.
- **✅ L2 DONE (#255, main `703a49a` 2026-07-08):** stranded contract types/constants relocated to a new
  **node-free `contracts/` leaf** (+ `OutboundSink` unified into `trident/outbound-sink.ts`, which needs a
  `channels/types.ts` type it can't take into the lowest band) with `export … from` shims at every old
  site: OnboardingPhase/ALL_PHASES, AgentEngagementMode+defaults, LlmCallFn, ChatCommandFilter,
  McpToolResolver, MOBILE_APP_URL/TELEGRAM_BIND_TOKEN_TTL_MS, OutboundSink×2→1. **DAG cuts #1/#7/#9
  landed** (depcruise 21→16, ratchet OK); #10/#11 are type-only (grep-verified). `.dependency-cruiser.cjs`
  registers `contracts` as a leaf band. **Skipped (already relocated):** ImportJobRunnerHook (K3),
  WebChatSenderRegistry (alive, node-free); ChatOutbound cut by L1. Codex APPROVE; one comment-truth fix
  (MOBILE_APP_URL canonical home). matrix 45/45; env-load-order preserved in `contracts/handoff-config.ts`.
  **⚠️ resume note:** agent worktrees are shallow/grafted — `git rebase origin/main` needs `git fetch
  --unshallow` first (see [[refactor-worktree-shallow-rebase-trap]]).
- **✅ L4 DONE (#258, main `83cb8c9`, merged 2026-07-08)** (manifest honesty + workspace promotion ·
  `sonnet` · lane ci). Promoted the 5 floating dirs (open/, tabs/, work-board/, project-credentials/,
  **contracts/** [new L2 leaf]) to real workspaces + declared their true deps. **Codex found the real
  bug:** the AST audit miscounted intra-package `@neutronai/<self>/…` imports, so gateway/runtime/
  onboarding each declared THEMSELVES as a dependency — removed the 3 self-dep lines. `bun install` +
  full matrix (47 tsconfigs) + broad tests + app/metro purity all green. Depgraph declared-vs-actual
  delta = 0.
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
- **K11e:** the LIVE dynamic `buildPersonaReviewedPromptSpec` "Looks good" CTA returns
  `next_phase_on_default: 'slug_chosen'` (`phase-prompts.ts:1635/1672`), while K11e retargeted the
  *static* spec + transition table to `completed`. **Byte-identical on main** (K11e never touched the
  dynamic builder — a definition-prune) and **intentional**: already pinned by
  `m2-ux-surface-fixes.test.ts:64`. Not the claimed live bug — a backward-to-slug accept would make
  onboarding un-completable, but it completes in prod; the live "Looks good" is routed by the engine's
  `consumePersonaReviewedChoice` handler, not this fallback. Codex r3 REQUEST_CHANGES DECLINED
  (documented on PR #251). Owner: a later onboarding-flow audit unit (align dynamic builder's default
  with the static spec / finalize routing).

**Review pattern (holding across every unit):** build agent → orchestrator diff review → Codex
cross-review (EVERY unit found ≥1 real defect: vacuous assertions, one-directional parity holes,
wrong anchors, boundary gaps, a clipboard sync-throw, the composer-injection regression, a latent
composition bug) → fix-loop → rebase onto main + `typecheck-all.sh` → CI green → squash-merge.

## Ready-set / queue (order: waves 1–9; K10 LAST)

**Wave 1: DONE** (all K units merged; K10 deferred to wave 9 — Ralph landmine; K11b2 ✅ #257 owner-approved delete).

**Wave 2 ready-set (§16 wave-2 row: L1 L2 L3 L4 L7 · C1 · W5 · W8✓ F9✓ · M1 M2):**
1. **L1** ✅ #253 · **L2** ✅ #255 · **L4** ✅ #258 · **L7** ✅ #260 · **L3** ✅ #262.
   - **L7 note:** pure `@neutron/chat-core` → `@neutronai/chat-core` scope rename (the one outlier of 41).
     Codex caught the agent mechanically renaming the old scope inside **dated point-in-time snapshots**
     (2026-07-02 audit set, AS-BUILT-archive, dated QA, migration `0079` comment) → corrupted them
     ("rename X → X"); reverted those, kept the rename only in living current-state docs. Codex #1
     (plan-docs name old scope) DECLINED — they name it as the unit's OWN spec; grep is code/config-scoped.
   - **L3 note — ⚠️ NO-CYCLES IS NOW A HARD ERROR (SCC = ∅).** Six injection-shaped edge cuts + two
     extra intra-package cycles (trident, gbrain-memory) the brief missed; `.dependency-cruiser.cjs`
     no-cycles flipped `error`, baseline 16→8. **Every future unit must keep the graph acyclic** — a new
     import cycle now fails CI outright. Codex REQUEST_CHANGES → APPROVE: (a) real manifest-honesty
     blocker — cut the source edges but left stale workspace deps; fixed (removed migrations→open,
     connect→onboarding, reminders→gateway/landing, agent-settings→connect; added open→contracts,
     onboarding→connect). (b) full-suite CI caught the G6 producer-conformance guardrail — the
     `cc-llm-call: aborted` literal relocated with `collectTokensToString` into `runtime/collect-tokens.ts`;
     repointed the source-text extraction. **Lesson → [[refactor-lphase-source-text-guardrail-trap]]:
     relocations pass tsc/matrix/depcruise via shims but break by-path source-text guardrails — run the
     FULL `test` check on every L-relocation.**
2. **C1** ✅ #265 (the flagship BootConfig long-pole).
   - **C1 note:** `config/` leaf resolves+validates env ONCE into a frozen `BootConfig` (68 fields,
     verbatim defaults, documented scope-exclusions for Expo/OS/subprocess-IPC/test vars); numeric knobs
     fail LOUD (no silent NaN); dual-entrypoint DB trap fixed; `open/server.ts` env-mutation → a shim
     writing FROM config; composer sub-builders still read `process.env` via the shim (marked to die —
     deliberate follow-up). Codex r1 caught 2 real verbatim-fidelity regressions → FIXED: (a) `.url_slug`
     effective-home desync (raw `config.ownerHome` ignored the rename on an `OWNER_HOME`-unset box — the
     legacy `open/server.ts` mutated `OWNER_HOME ||= neutronHome` before boot read it; now resolves from
     `config.ownerHome ?? config.neutronHome`, the value the shim publishes); (b) `NEUTRON_PORT` lost its
     canonical-decimal guard (`0x10`→16). Codex r2 port-precedence finding DECLINED (fail-loud is the C1
     mandate; prod passes a resolved config; explicit-port precedence preserved for valid/unset env; all
     cited `boot({port:0})` callers pass).
3. **W5** ✅ #263 (chat-core connection resilience `[BEHAVIOR]`).
   - **W5 note — WAVE 2 LOCAL UNITS COMPLETE.** The 4 shared socket-lifecycle gaps (heartbeat/half-open,
     reachability reconnect, ack-timeout→`failed`, resume-on-every-reopen) + a fully-wired per-message
     `failed`/retry affordance on BOTH web and mobile. **7 Codex rounds** — a real defect each round,
     all fixed: dup-resume on late `session_ready`; fallback-on-closed-socket unhandled rejection; GAP-2
     web `online` listener; durable-store `failed`→`queued` corruption; native mobile ack-timeout parity
     (+ 11 pre-existing mobile heartbeat failures round-1's verify missed); deactivated-client revival on
     late open; heartbeat-not-rearmed-on-foreground; web+mobile retry wiring → per-message `flushOne`
     (was resending all unacked). Orchestrator merged current `main` (C1) into the branch mid-review to
     clear branch-lag artifacts — **lesson: a long-running unit's branch goes stale when siblings merge;
     re-integrate `origin/main` (code + docs) before final review, or Codex flags the missing sibling
     changes as regressions.**
4. **Wave 2 status:** LOCAL units DONE (L1 L2 L3 L4 L7 · C1 · W5 · W8✓ F9✓). Only **M1/M2** (Managed,
   cross-repo neutron-managed) remain from the §16 wave-2 row — deferred to a Managed pass.
5. **C2** ✅ #268 (boot-helpers split + delete the 8 dead exports + `loadInstanceEnvOverlay`; Codex APPROVE
   first pass; full suite 807/807; contract-neutral — only dead re-exports removed from the Managed-pinned
   `gateway/index.ts`; boot-helpers.ts → a `composer-contract.ts` shim).
6. **L6** ✅ #270 (`@neutronai/wire-types` leaf + option-shape unification). 5 option shapes → 1 canonical
   `WireAgentMessageOption` + 2 explicit projections (ButtonOption's lossy Telegram `metadata` edge;
   InlineChoice's render projection + "label carries display text"); ~770 mirror lines deleted; G3 parity
   tests converted from drift-guards to contract tests. **Codex caught a browser-safety regression** (2
   rounds): the barrel re-exports `doc-links`, which read `process.env` at module-init → crashed the
   landing browser bundle; r1 guarded it but the runtime `HAS_PROCESS_ENV` gate then defeated Expo's
   compile-time inlining (returned `''` on Expo); r2 fixed with **try/catch around DIRECT member reads**
   (babel inlines for Expo, throws-caught for processless browser, runtime read for server) + config.ts
   imports topic-id from the narrow subpath so doc-links never enters the browser bundle. **Lesson →
   [[refactor-lphase-source-text-guardrail-trap]] cousin: a shared leaf imported by browser code must be
   browser-safe end-to-end; guarding an env read can silently defeat build-time inlining on another
   surface — verify all three (server / Expo-inlined / processless-browser).** CI flake on `anchor-walker`
   (unrelated concurrency test) cleared by re-run → [[neutron-open-anchor-walker-ci-flake]].
7. **C3a** ✅ #272 (first `open/composer.ts` carve → `open/wiring/{context,substrates,memory}.ts`). The
   4015-line closure's substrate slice (`cc-llm-*` phase-spec + prewarm, `cc-agent-*` live-chat, ephemeral
   `cc-trident-*` factory, warm-per-cwd `cc-trident-fire-*` cache) + memory slice (`cc-scribe-*` extraction,
   lazy fail-soft GBrain, `cc-reflection-*` judge, `scribeOnUserTurn`, Cores fan-out) carved VERBATIM into
   narrow-`OpenWiringContext` leaf modules; composer −326/+49. **Two required deviations only:** `let
   prewarmSettled` → `prewarmSettledRef: {settled}` **live reference** (cold-window budget elevation reads
   the live value the never-rejecting prewarm `.then` flips — a snapshot would break it); inline
   `realmodeCleanups.push` → a returned `cleanups[]` the composer re-registers AT THE SAME SITE (SIGTERM
   order byte-identical, GBrain-close before fan-out-stop). Characterization snapshot pins Open's
   `CompositionInput` field-key set. **Codex REQUEST_CHANGES (test-gap, not a defect):** memory tests
   discarded captured substrate opts → a future `enableToolBridge:true` on `cc-scribe`/`cc-reflection`
   would slip; FIXED by dispatching each via its consumer (scribe `extractAndWrite`, reflection
   `onTurnComplete` behind a cue) + asserting no-bridge + ephemeral. **Lesson: `buildLlmCallSubstrate`
   invokes `substrateFactory` LAZILY (on `start()`) — a boundary test must DISPATCH the substrate, not just
   build it; and scribe filters text < `SCRIBE_MIN_CHARS` (80) before dispatch.** Local doc-link lane flake
   (pre-existing, unrelated) did NOT recur on CI (`test` green 8m16s).
8. **IN FLIGHT:** none (dispatching C3b).
9. **Next dispatchable (wave 3):** **C3b** (carve `open/composer.ts` uploads + landing-stack + onboarding
   seams — chunked upload+sweeper, `buildLandingStack` call, Path-1 trio + import watcher,
   `importUseSynthesis:true` preserved; `opus`, lane composer; serial after C3a). Then **C3c** (http-shell
   → named `OpenOwnerGate`), **C3d** (app surfaces + app-ws + return assembly + `late<T>` holders). **L5**
   (relative-import autofix sweep, `haiku`) — HOLD until the C3 relocations settle (avoid import-rewrite
   conflicts). **M1/M2** = Managed (cross-repo, deferred). **K10 strictly LAST (wave 9).**

**Then waves 3–9** (C → D → P → O → X → W → M → N → S) per §16. K10 strictly LAST (wave 9).

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
