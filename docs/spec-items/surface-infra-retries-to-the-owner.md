---
title: Surface infrastructure retries to the owner
group: trident
status: open
priority: P2
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

**An infrastructure retry is invisible to the owner — the board says nothing and
the run row carries no count** (split out 2026-09-12 from the auto-retry item,
which is otherwise DONE via PR #367).

The auto-retry itself shipped: a measured infrastructure failure is classified and
retried with no human in the loop, on a budget separate from the fix-round counter
(`begin_infra_retry`, `max_infra_retries`, `trident/orchestrator.ts:382-387`).
**Acceptance (d) of that item — "Visible: the board reads retrying-with-attempt-count,
not `failed`; the owner is told ONCE, not once per attempt" — was never wired.**
Two independent gaps, both measured 2026-09-12:

1. **The owner-visibility seam is declared and never passed.** `on_infra_retry` —
   *"Best-effort owner/visibility seam, invoked once on durable attempt 1 only"* —
   is declared at `trident/orchestrator.ts:387` and read at
   `trident/orchestrator.ts:2197` (`const onInfraRetry = opts.on_infra_retry`). A
   whole-tree search finds it passed in **exactly one place, a test**
   (`trident/infra-retry.test.ts:217`). No production composition supplies it, so
   the "told ONCE" half fires never rather than once.

2. **The count never reaches the card.** `infra_retries` is a real column — it is in
   the live schema (`migrations/expected-schema.txt:631`) and in the run table
   rebuilds (`migrations/0138_code_trident_runs_review_not_run.sql:102`) — but it is
   **absent from `RunProgress`** (`trident/run-progress.ts:60-100`, which carries
   `round`, `stalled`, `verdict`, `failure_reason`, `brief_alert` and no retry
   count). The wire type the card renders cannot express "retrying, attempt 2", so
   the surface has nothing to show even though the database knows.

**Why this matters more than a cosmetic gap.** The whole argument for auto-retry was
that a human should not have to notice an infrastructure failure. Retrying silently
replaces one invisible state with another: a run that is quietly burning its retry
budget is indistinguishable, on every surface the owner has, from a run that is
simply slow. And when the budget is exhausted the owner sees a terminal failure with
no indication that three attempts preceded it — which is the same
confidently-worded-and-incomplete shape the terminal-reason work (#240) exists to
prevent.

## Acceptance

- [ ] `on_infra_retry` is supplied by the PRODUCTION composition, not only by a test.
      A search for its call sites finds a non-test caller.
      verify: `rg -n "on_infra_retry" --glob '!**/*.test.ts'` names a composition file
- [ ] The owner is told ONCE per run, not once per attempt. A run that retries three
      times produces exactly one owner-facing notification.
      Assert the negative too: a run that retries zero times produces none.
- [ ] `RunProgress` carries the retry count, so the card can render
      "retrying, attempt N". Deleting the field from the wire type must turn a test red.
      verify: `bun test trident/run-progress` and `bun test trident/infra-retry`
- [ ] A run inside its retry budget does NOT read `failed` on the board. A test pins a
      mid-retry run rendering as retrying; a mutant that reports `failed` goes red.
- [ ] A run that EXHAUSTS the budget still fails terminally, with a reason naming the
      budget. Visibility must not become a path that keeps a dead run alive.
