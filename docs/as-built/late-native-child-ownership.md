## 2026-10-09 — Reconcile original ownership when a native child binds late

A native child can appear after the host observation window and leave its signed
journal at `submission-started`. Even with a valid late result, passive recovery
previously required `child-bound`, retaining the original lease and blocking a
sibling planner's census. The existing submission verifier was used by planner
authority retirement, which requires separate host authority and does not recover
this completed build (`open/wiring/never-admitted-planner-retirement.ts:103`).

Passive reconciliation now authenticates the original submission against the
canonical lease and unknown attempt, then obtains a unique full-request child
binding from the original live parent's canonical transcript location
(`open/wiring/claude-native-dispatch-reconcile.ts:65`). The bounded provider reader
supplies identity only. The original armed reservation, canonical path and live
execution's result validator still establish completion. Reconciliation confirms
the binding and parent again before exact-token release. Original session, PID
and kernel birth identity must match. The current wrapper is pinned throughout
observation; a differing wrapper generation is accepted only with the exact
native process identity (same file, line 107). Ordinary boot adoption normally
restores the recorded generation; the changed-generation control exercises the
identity contract, not an assertion that normal adoption changes generation. No signed
journal, attempt, result, run or budget is rewritten, and no native input is sent.

The consuming tests cover a completed late build, adopted parent wrapper,
ambiguous or malformed binding, changed process/request/signature/lease/result,
and changes during observation. A measured sibling planner refuses its real host
capability before reconciliation and serves its brief afterward; unrelated leases
survive. Actual Open startup and periodic recovery consume the original evidence
with zero native turns
(`open/wiring/__tests__/claude-native-dispatch-boot.test.ts:145`, `:256`, `:423`).
Existing project-build E2E lost-acknowledgement, native planner and passive panel
consumers provide surrounding execution coverage, while the boot tests directly
exercise the new recovery and planner behavior. The same delivery adds queued
dispatch E2E cases recorded in `claude-queued-dispatch-compaction.md`.

Focused verification: the boot suite passed 163 tests and 397 assertions with
`bun test --timeout 15000`; six selected project-build E2E tests passed with 86
assertions. Open TypeScript checking passed. The initial default five-second
harness runs hit composition teardown timeouts and subsequent spy failures;
the bounded rerun used the canonical harness timeout without changing source
or runtime budgets. Seven isolated mutations each failed its behavioral guard
while a control passed: restore the original reconciler, bypass child binding,
ignore process birth, bypass signature authentication, bypass result validation,
skip the final binding check, and require the historical wrapper generation.
Every mutation was restored. Full-suite, integration, publication and deployment
verification remain delivery work; this slice does not establish autonomous
build completion.

After restoring mutations, the 38 focused recovery and planner tests passed with
177 assertions; Open TypeScript checking passed again. The five changed files
plus the license passed the leak gate with zero findings. This scoped preflight
is not a whole-tree publication receipt.

Cross-model review initially returned NO-GO: the identity check reused the usage
collector, whose 8 MiB transcript and 256 KiB per-line limits rejected completed
larger builds even when their first request envelope was valid. Recovery now uses
a binding-only reader in `runtime/workers/claude-child-observation.ts`, sharing
bounded metadata uniqueness and the timeout with usage collection, but reading
only the first envelope. The read retains `O_NOFOLLOW`, `O_NONBLOCK`, regular-file
checks and the first-envelope bound. Usage retains its original whole-transcript
limits. Original dispatch/process/result checks and the final binding rescan are
unchanged. This binding-reader correction does not broaden parent selection or
change queued-input handling.

The consuming large-transcript and oversized-later-line cases first failed
against the original binder, while wrong-first-request and duplicate-child
controls passed. The corrected reader passes these cases and retains oversized
first-envelope, malformed envelope, metadata, symlink, FIFO and timeout refusals.

Correction verification: 46 focused recovery/planner/startup/tick tests passed
with 192 assertions, and all 33 runtime observation tests passed with 79
assertions. Open and runtime TypeScript checks passed. A mutation restoring the
usage-based binder reproduced exactly the two large-tail positive failures while
all four wrong-first-request/duplicate controls passed; restoring the binding-only
reader made the focused checks green. The correction's changed-file leak
preflight passed. Independent native and bounded cross-model source reviews
approved the corrected implementation. The completed combined local receipt and
subsequent fixture correction are recorded in
`claude-queued-dispatch-compaction.md`: all 1,801 files executed, with two failures
and no full-suite pass claimed for the corrected publication head. Exact-head CI,
deployment and unattended acceptance remain required.
