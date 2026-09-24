## 2026-09-24 — Preserve host failure identity through complete large diagnostics

Issue #1261. A partitioned suite emitted an ordinary 21,689-character mutation
exemption diagnostic. Its failing round contained 19 Bun starts, 19 completions,
one named failure and its matching summary, but `suiteFailure` discarded the
identity because any line exceeding 16,384 characters marked the log incomplete.
The unknown identity then reached the existing G072 review-progress refusal.

`trident/suite-failure.ts` now retains complete lines up to 65,536 characters.
This remains a bounded parser: larger lines invalidate identity, and every newly
accepted line receives the existing fatal-error, count, completion and named-test
checks. No log is silently truncated into proof. G063/G065 evidence requirements,
G070/G071 arbitration and G072 unknown handling are unchanged. No driver control
flow was modified.

Parser/gate checks passed (16 tests, 120 assertions), including the measured
diagnostic size, exact upper boundary, one-character overflow and a long fatal
record. Semantic mutations were killed by assertions in both directions:
restoring the old limit loses a legitimate named identity; suppressing overflow
invalidation invents identity for incomplete output. Initial mutant setup runs
with unresolved imports were discarded and are not semantic evidence.

The consuming `open/__tests__/project-build-e2e.test.ts` exercises large diagnostics
through repeated-red arbitration, improving failures followed by green, and
targeted base comparison. An oversized-log case cannot earn the pre-existing-red
exemption. Both root and Trident TypeScript checks passed. The consuming run was
concurrent with another branch's full-suite verification and is not an
uncontended terminal validation receipt. Its changed cases passed, but unrelated
owner-session fixtures could not listen on Unix sockets in the restricted
sandbox (`EPERM`); an unrestricted consuming rerun remains outstanding. No full
suite was run for this change while that lane owned the slot.

Reparsing the captured failing log now yields a named host-suite identity. That
proves the parser repair only: other review-progress gates may still stop the
historical run, and the failing app-websocket test is a separate defect. A fresh
deployed run remains necessary to establish unattended completion.
