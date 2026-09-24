---
title: Surface infrastructure retries to the owner
group: trident
status: done
priority: P2
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

**An infrastructure retry is visible to the owner.** When a run spends its first
automatic infrastructure retry, the production composition tells the originating
chat once, and the run's card reads `Retrying` with its attempt count instead of
`failed`. A run that exhausts the retry budget still fails terminally with a reason
that names the budget. This shipped in PR #904 (merge commit
`5d72f26fa5a7d58688d94ebac8a250a91b73d087`, which closed inbox issue #535; record
`.trident/as-built/fix/535-fix.md`) and is reconciled into the queue by #1212. The
item was split out on 2026-09-12 from the auto-retry item (DONE via PR #367); the
two gaps measured on that date described the tree before #904.

The auto-retry itself classifies a measured infrastructure failure and retries it
with no human in the loop, on a budget separate from the fix-round counter
(`begin_infra_retry`, `max_infra_retries`, `on_infra_retry` declared at
`trident/orchestrator.ts:451`, read at `:1303`, passed into
`tryInfrastructureRetry` at `:2531`).

## Shipped behaviour and provenance

1. **Production supplies the owner-visibility seam.**
   `gateway/composition/build-core-modules.ts:823` wires
   `begin_infra_retry = store.beginInfraRetry`, and `:824-825` wires
   `on_infra_retry` to `deliverInfraRetry(tridentWiring.delivery_sink ?? router, …)`
   (imported at `:80`). `deliverInfraRetry` (`trident/delivery.ts:1451-1466`) posts
   "Infrastructure interrupted this build. Retrying automatically (attempt N)."
   plus the measured cause to the run's originating topic, and is a no-op when the
   run has no originating chat.

2. **The owner is told once per run, and never when nothing retried.**
   `trident/infrastructure-retry.ts:114-136` spends the durable budget through an
   atomic claim (a lost claim waits and fires nothing), schedules the backoff from
   `INFRA_RETRY_BACKOFF_MS` (`:11`, one, five and fifteen minutes;
   `DEFAULT_MAX_INFRA_RETRIES` at `:12` is derived from it), and invokes the
   observer only when the claimed row reads `infra_retries === 1`. An observer that
   throws is logged and cannot stop the retries. A genuine failure never enters
   this branch, so a run that retries zero times sends nothing.

3. **The count reaches the card.** `RunStepLabel` includes `retrying`
   (`trident/run-progress.ts:53`), `RunProgress` carries `infra_retries`
   (`:73`), and `deriveRunProgress` projects `step_label: 'retrying'` only while the
   run is non-terminal with `infra_retries > 0`, otherwise the phase-derived label,
   so terminal rows keep `failed` or `done` (`:245-249`). Both clients accept the
   label (`app/lib/work-board-client.ts:111,371`,
   `landing/chat-react/work-board-client.ts:141,424`) and render a build-coloured
   `Retrying` tag whose pulse is gated on a fresh heartbeat
   (`app/lib/work-board-helpers.ts:235,338`,
   `landing/chat-react/WorkBoardTab.tsx:223,319`).

4. **Exhaustion still fails terminally.** `trident/infrastructure-retry.ts:93-111`
   fails a run whose `infra_retries` has reached the budget with
   "infrastructure failure persisted after N automatic retries (budget N) — not
   retrying again. Last measured cause: …" and records `inner_verdict`
   `REVIEW_NOT_RUN`. Visibility is not a path that keeps a dead run alive.

**Why the queue read open after the work shipped.** The item was split out of
SPEC.md on 2026-09-12 (#514) describing the gaps as measured then. PR #904 closed
the inbox issue and wrote its record under `.trident/as-built/`, but never touched
this file. `docs/process/work-tracking.md` §3.4 makes this queue, not the inbox, the
answer to "what is done", so the item stayed open until #1212 reconciled it.

## Acceptance

- [x] `on_infra_retry` is supplied by the PRODUCTION composition, not only by a test.
      A search for its call sites finds a non-test caller.
      verify: `rg -n "on_infra_retry" --glob '!**/*.test.ts'` names a composition file
      (`gateway/composition/build-core-modules.ts:824`); pinned by
      `gateway/__tests__/trident-crash-recovery-wiring.test.ts:37-40`.
- [x] The owner is told ONCE per run, not once per attempt. A run that retries three
      times produces exactly one owner-facing notification.
      Assert the negative too: a run that retries zero times produces none.
      verify: `trident/infra-retry.test.ts:245-269` (three retries, one observer
      call for attempt 1, a throwing observer does not stop retries) and the
      zero-call assertion in the `(b) genuine failures never auto-retry` test
      (`trident/infra-retry.test.ts:179-211`, assertion at `:208`).
- [x] `RunProgress` carries the retry count, so the card can render
      "retrying, attempt N". Deleting the field from the wire type must turn a test red.
      verify: `bun test trident/run-progress` and `bun test trident/infra-retry`;
      `trident/run-progress.test.ts:55-60`, `app/__tests__/work-board-helpers.test.ts:109-119`
      and the "shows retrying without claiming a pulse" case in
      `landing/chat-react/__tests__/work-board-tab.test.tsx:250`.
- [x] A run inside its retry budget does NOT read `failed` on the board. A test pins a
      mid-retry run rendering as retrying; a mutant that reports `failed` goes red.
      verify: `trident/run-progress.test.ts:58-59`, `trident/infra-retry.test.ts:268`
      and `:314-326`, `app/__tests__/work-board-helpers.test.ts:109-119`.
- [x] A run that EXHAUSTS the budget still fails terminally, with a reason naming the
      budget. Visibility must not become a path that keeps a dead run alive.
      verify: `trident/infra-retry.test.ts:214-243` (`(budget 2)`, measured cause,
      `REVIEW_NOT_RUN`, phase `failed`).
