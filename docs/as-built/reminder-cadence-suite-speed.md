## 2026-09-24 — Drive reminder composition tests through a controlled scheduler

This is a focused local suite-latency slice of #1196, governed by
`docs/spec-items/trident-build-efficiency.md:190` and `:203`. It does not establish
deployed Trident efficiency or close that issue.

The four reminder composition cases previously waited for the native 30-second
interval. `ReminderTickOptions.scheduler` now carries paired timer operations
through the existing `SupervisedLoop` seam (`reminders/tick.ts:83`, `:134`). Open
threads the optional dependency through the production graph. With the option
omitted, the loop still uses the native timer and the same 30,000 ms cadence
(`reminders/tick.ts:130`). No dispatch, delivery, retry, or gate logic changed.

The three consuming test files retain the real command/store → supervised tick →
dispatcher → delivery → WebSocket path and their original assertions. They invoke
the callback registered by composition, and assert exactly one timer registration
at 30,000 ms and one clear operation on shutdown. The lifecycle test additionally
checks no eager dispatch, idempotent start/stop, overlap suppression, and shutdown
waiting for a blocked delivery before the row becomes fired
(`reminders/tick.test.ts:36`).

Comparable local measurement: same isolated worktree, Bun 1.3.13, dependency tree,
test command, four cases, and real localhost sockets. Baseline source was
`519c1eae8`. Host contention was not instrumented; these are individual local
measurements, not a full-suite or deployed-path benchmark.

| Case | Before | After |
| --- | ---: | ---: |
| Nudge floor-notice composer | 32,128.27 ms | 2,230.02 ms |
| Project reminder delivery | 30,962.26 ms | 996.01 ms |
| General/null reminder | 30,948.26 ms | 1,038.01 ms |
| Live reminder delivery | 30,938.26 ms | 1,006.01 ms |
| Sum of named cases | 124,977.05 ms | 5,270.05 ms |

Both invocations ran `bun test` with
`open/__tests__/nudge-floor-notice-composer-wiring.test.ts`,
`open/__tests__/open-project-reminder-appws-live-delivery.test.ts`, and
`open/__tests__/open-reminder-appws-live-delivery.test.ts`, in that order. Process
wall durations were 125.57 s and 5.83 s; each passed all four cases.

Semantic controls were exercised separately and restored: changing the default
cadence to 1 ms failed the timer assertion; removing the Open scheduler forwarding
failed the consuming registration assertion; making stop return before quiescence
failed the blocked-delivery lifecycle assertion; suppressing the tick body failed
the live delivery case with the row still pending. Each mutant executed tests and
failed behavior assertions, not parsing. The restored combined reminder and
composition checks passed 87 cases across ten files (541 assertions), including
default-composer characterization and loop inventory. Both root and Trident
TypeScript checks passed. Initial sandboxed socket attempts were rejected by the
environment and are not counted as green runs; socket-enabled reruns passed.

The composition-field inventory classifies `reminder_scheduler` as an intentionally
unset test seam, alongside `pid_probe`: the default Open composer omits it, while
explicit test injection is forwarded to the real loop. The coverage check reproduced
the missing-classification failure before this entry and passed all five cases
afterward; the focused reminder/composition rerun passed all 87 cases. No existing
wired field was demoted and the inventory guard remains unchanged.

The full suite was deliberately deferred while a live Trident run was active.
`open/__tests__/project-build-e2e.test.ts` was not run: this slice does not touch
publication, admission, or review. Full-suite/CI, review, merge, and deployment
remain separate validation; no token or deployed wall-time saving is claimed.
