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
- **main HEAD:** `89728c2` (W8 #197 merged). **CI baseline GREEN** — restored by #198
  after discovering #196 had turned it red (see Done). Leak-gate now allowlists the
  tracked plan doc (§1.4 / D-11).
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

## In flight (wave 0 — Phase-0 guardrails, first distinct-lane batch)

- **G5** (typecheck completeness · `opus` · lane **ci**) — CI must `tsc -p` every dir with a
  tsconfig + add leaf tsconfigs + strip `DOM` from root/server; fix the wrong-runtime errors
  it surfaces. Highest-value guardrail (catches the leaf-tsc-miss class I hit twice on W8).
- **G1** (route-matrix characterization · `opus` · lane **none**) — snapshot the Open composer
  route ladder + negative space; protects the C-phase.
- **G10** (invariants inventory · `sonnet` · lane **docs**) — compile `docs/INVARIANTS.md`
  from the 12 critic reports; the per-merge Fable-synthesis checklist.
- Remaining wave-0: G2 G3 G4 G6 G7 G8 G9 · W0 · M0 (dispatch as lanes free, cap 3).

## Ready-set / queue (order: Step 0 → G1–G10 → waves 1–9; K10 LAST)

**Step 0 (Wave −1, do next, independently shippable live-bug fixes):**
1. **W8** — chat client cheap wins, *pull cache-busting first* (#353 bites every deploy).
   `sonnet` · lane clients. Plan §W8 (~line 1479).
2. **W7-crash** — the #354 blank-screen crash slice only (stable-mount snapshot-cache +
   fiber-unmount fix). `opus` · lane clients. Rest of W7 stays in wave 7. Plan §W7.

**Then Phase-0 guardrails G1–G10** (merge before structural waves — G1 route-matrix,
G2 hydration-parity-pin, G4 depcruise baseline, G6 error-string conformance, etc.), then
**waves 1–9** per the §16 wave table. K10 sequenced last (D-4 governed-mode landmine).

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
