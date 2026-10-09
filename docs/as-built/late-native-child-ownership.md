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
and kernel birth identity must match; adoption can change the gateway wrapper
generation without changing that native process (same file, line 107). No signed
journal, attempt, result, run or budget is rewritten, and no native input is sent.

The consuming tests cover a completed late build, adopted parent wrapper,
ambiguous or malformed binding, changed process/request/signature/lease/result,
and changes during observation. A measured sibling planner refuses its real host
capability before reconciliation and serves its brief afterward; unrelated leases
survive. Actual Open startup and periodic recovery consume the original evidence
with zero native turns
(`open/wiring/__tests__/claude-native-dispatch-boot.test.ts:145`, `:256`, `:423`).
The existing project-build E2E file remains unchanged: its lost-acknowledgement,
native planner and passive panel consumers provide surrounding execution coverage,
while the boot tests directly exercise the new recovery and planner behavior.

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
