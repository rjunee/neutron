---
title: Store per-phase token and cost accounting for every Trident run
group: trident
status: done
cutover: false
priority: P2
---

# Per-phase accounting (#554)

Store one cumulative snapshot per run and model-phase key from
`trident/phase-models.ts`. This is a storage contract; provider collection and
pricing are outside this change. A phase with no report is `unknown`, with NULL
measurements and no observation metadata. Unknown does not establish whether the
phase ran, was skipped, failed, or consumed nothing.

A report supplies absolute totals across all attempts of that phase in this run,
not a delta or a workflow-wide total. Input tokens exclude cache reads and cache
creation; those have separate counters. Output tokens and USD cost have their
own fields. Cost is supplied by the reporter, never inferred from tokens.
Zero is valid only when explicitly reported. `partial` means at least one metric
is known and at least one is unknown; `complete` means all five metrics are known.
Complete describes metric coverage, not workflow completion. Reports carry a
source identifier and observation time (epoch milliseconds). Newer snapshots
replace older ones; duplicate or older observations are refused without writing.

## Acceptance

- [x] Every existing and newly inserted run has all catalog phases stored as unknown,
  even without a working reporter. SQLite seeds these rows atomically.
- [x] Valid partial, complete and explicit-zero reports survive closing/reopening the
  database and ordinary run snapshot saves. Repeated reports cannot add spend.
- [x] Invalid phase/run references, negative or fractional token counts, negative or
  nonfinite cost, incoherent coverage and missing provenance cannot be stored.
- [x] Reads distinguish an unknown run from an existing run with unknown accounting.
  Missing metrics remain NULL; this change supplies no misleading sum of them.
- [x] The phase catalog must match the existing model-phase registry, including its
  mechanical-build follower. Tests enumerate that registry, not a second expected
  list.

Verify with `bun test trident/phase-usage.test.ts migrations/snapshot.test.ts`.
The normal CI test discovery runs both files.
