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

Initial parser/gate checks passed (16 tests, 120 assertions), including the measured
diagnostic size, exact upper boundary, one-character overflow and a long fatal
record. Semantic mutations were killed by assertions in both directions:
restoring the old limit loses a legitimate named identity; suppressing overflow
invalidation invents identity for incomplete output. Initial mutant setup runs
with unresolved imports were discarded and are not semantic evidence.

CI run `35959557000`, shard 1/4 (job `107505001746`), executed all 288 named
`open/__tests__/project-build-e2e.test.ts` cases: all passed, with no skips.
These cover repeated-red arbitration, improving failures followed by green,
targeted base comparison, and oversized-log refusal. The nine owner-session
cases that hit Unix-socket `EPERM` locally also passed in CI. Both root and
Trident TypeScript checks passed in job `107505001583`. The CI checkout's tree
equals reviewed head `5467cf334`; these are explicit consuming and typecheck
receipts, not an inference from aggregate green.

The initial concurrent restricted-sandbox local invocation remained RED:
279 passed and nine failed on socket permissions. No local full suite was run
for this change while the other lane owned the slot. The remote consuming
receipt satisfies that implementation check; the deployed live merge criterion
remains outstanding.

After rebasing onto `faef1c2ed`, added regressions cover a fatal record hidden
behind 4,000 ANSI color sequences and long file headers. Complete headers above
the old limit must change attribution; headers above the new bound must refuse
identity. The consuming targeted-base-comparison fixtures reject both malformed
evidence and changed attribution while the valid long-diagnostic sibling merges.
Focused parser/gate checks passed 17/17 (130 assertions); targeted consuming
checks passed 12/12. Restoring the old cap killed two assertions with one sibling
passing; suppressing overflow invalidation killed one with two siblings passing.
The restored parser/gate run passed 17/17 again. These mutations ran valid code.
Both explicit root and Trident TypeScript checks passed, followed by all 51
configs in `scripts/ci/typecheck-all.sh`. The updated consuming file ran all 291
cases: 282 passed and nine failed only on sandbox-denied Unix sockets, with no
skips. Re-running precisely those nine cases with socket access passed all nine
(125 assertions); the other cases were deliberately filtered in these retries.
Every consuming case therefore has a passing local receipt, while the original
restricted invocation remains red. The solo full suite is pending its test slot.

Reparsing the captured failing log now yields a named host-suite identity. That
proves the parser repair only: other review-progress gates may still stop the
historical run, and the failing app-websocket test is a separate defect. A fresh
deployed run remains necessary to establish unattended completion.
