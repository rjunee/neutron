---
title: Surface infrastructure retries to the owner
group: trident
status: done
priority: P2
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

> **SHIPPED** in #904 (merge `5d72f26f`, 2026-09-15), which closed #535 and wrote its record at
> `.trident/as-built/fix/535-fix.md`. Reconciled to `done` on 2026-09-23 under #1212; the
> reconciliation record is `docs/as-built/1212-reconcile-retry-visibility-spec.md`. The queue
> stayed `open` because #904 never edited this file.

**An infrastructure retry is visible to the owner: the board reads retrying with an attempt
count, and the owner is told once per run.**

The production composition supplies the owner-visibility seam. Beside the durable budget
claim (`orchestratorOpts.begin_infra_retry`), `gateway/composition/build-core-modules.ts:824-825`
assigns `orchestratorOpts.on_infra_retry = (run, attempt, cause) => deliverInfraRetry(...)`,
routed through the Trident delivery sink. The orchestrator declares the seam at
`trident/orchestrator.ts:448`, reads it at `:1299` and hands it to the retry step at `:2508`.

The observer fires once per run, from inside the claim branch. `trident/infrastructure-retry.ts:92`
enters the retry path only for a result classified `infrastructure`; the observer is invoked at
`:121-130` only after a successful durable claim and only when `claimed.infra_retries === 1`, so
later attempts and genuine failures produce no notice. A throwing observer is caught and logged
(`:122-129`) and cannot stop the retry. `deliverInfraRetry` (`trident/delivery.ts:1451`) posts to
the originating chat and skips a run that has none.

The count is on the wire. `RunProgress` declares `infra_retries: number`
(`trident/run-progress.ts:73`) and `deriveRunProgress` emits it (`:247`); a non-terminal run with
`infra_retries > 0` selects the `retrying` step label (`:243-245`) instead of a failed or
ordinary step. Both client decoders retain the field (`app/lib/work-board-client.ts:432`,
`landing/chat-react/work-board-client.ts:485`), and the mobile and web boards render a
`Retrying` tag that pulses only with a fresh heartbeat.

Visibility does not keep a dead run alive. When `run.infra_retries >= maxInfraRetries`
(`trident/infrastructure-retry.ts:93-111`) the run fails terminally with the reason
`infrastructure failure persisted after N automatic retries (budget N) — not retrying again.
Last measured cause: …` and `inner_verdict: 'REVIEW_NOT_RUN'`.

**History.** This item was split out on 2026-09-12 (#514) from the auto-retry item, which is
done via #367. It was measured then as two gaps: the `on_infra_retry` seam was declared but
passed only by a test, and the retry count was absent from `RunProgress`. #904 closed both.

**Why it matters.** Auto-retry exists so a human does not have to notice an infrastructure
failure, and a silent retry would replace one invisible state with another: a run burning its
retry budget would look the same as a slow run, and an exhausted budget would surface as a bare
failure with no sign that attempts preceded it. The count on the card and the single notice
keep the retry legible without turning each attempt into noise.

## Acceptance

- [x] `on_infra_retry` is supplied by the PRODUCTION composition, not only by a test.
      A search for its call sites finds a non-test caller.
      verify: `rg -n "on_infra_retry" --glob '!**/*.test.ts'` names a composition file
      (`gateway/composition/build-core-modules.ts:824`); pinned by
      `gateway/__tests__/trident-crash-recovery-wiring.test.ts:37-40`
- [x] The owner is told ONCE per run, not once per attempt. A run that retries three
      times produces exactly one owner-facing notification.
      Assert the negative too: a run that retries zero times produces none.
      verify: `trident/infra-retry.test.ts:246-270` (three retries, a throwing observer,
      `calls` is exactly one attempt-1 entry) and `trident/infra-retry.test.ts:179-212`
      (a genuine failure retries zero times and `calls` is empty, `:209`)
- [x] `RunProgress` carries the retry count, so the card can render
      "retrying, attempt N". Deleting the field from the wire type must turn a test red.
      verify: `bun test trident/run-progress` and `bun test trident/infra-retry`;
      `trident/run-progress.test.ts:53-58` reads `infra_retries === 2`. Deleting the
      interface field turns `tsc -p trident/tsconfig.json` red at `trident/run-progress.ts:246`
      and `trident/run-progress.test.ts:55`; deleting the emitted field turns
      `trident/run-progress.test.ts:55` red at runtime (remeasured 2026-09-23, restored)
- [x] A run inside its retry budget does NOT read `failed` on the board. A test pins a
      mid-retry run rendering as retrying; a mutant that reports `failed` goes red.
      verify: `trident/run-progress.test.ts:53-58` (`step_label` is `retrying`, `phase_label`
      is not `failed`; flipping the selector at `trident/run-progress.ts:243` turns `:56` red);
      `app/__tests__/work-board-helpers.test.ts:109-119` and
      `landing/chat-react/__tests__/work-board-tab.test.tsx:250-291` pin the `Retrying` tag
- [x] A run that EXHAUSTS the budget still fails terminally, with a reason naming the
      budget. Visibility must not become a path that keeps a dead run alive.
      verify: `trident/infra-retry.test.ts:215-244` (`phase` is `failed`, reason contains
      `(budget 2)` and the measured cause, verdict `REVIEW_NOT_RUN`)
