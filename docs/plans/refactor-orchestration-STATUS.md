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
- **main HEAD:** `00bd398` (F9 #194 merged). CI baseline GREEN.
- **CI infra:** `.github/workflows/ci.yml` throttled to `NEUTRON_TEST_CONCURRENCY=2`,
  `CHUNK_SIZE=75` (conservative guaranteed-green; ~2× wall-clock). Raise / set
  `NEUTRON_TEST_JOBS>1` once a faster runner is wired. Runner-upgrade decision PENDING
  (see [[neutron-open-ci-baseline-git-identity]] — personal repo → no hosted larger
  runners; realistic path = self-hosted runner on Ryan's Mac, needs his ~3-min reg).

## Done

- **CI baseline repair** (#195, `41b57c0`) — real-git trident tests needed a repo-local
  git identity on Linux CI (was masquerading as OOM). main green.
- **F9** (#194, `00bd398`) — `[BEHAVIOR]` trident conflict-resolver tools + humanized
  delivery + REAL passthrough test. **This was the orchestration PILOT** — proved the
  full machine: worktree build-agent → Argus/Codex review → CI green → squash-merge.
  §17 ticked.

## In flight

- (none — between units. Next turn: open the Step 0 remainder.)

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
