## 2026-09-24 — One host-owned terminal suite receipt

Refs #1196; this is a focused slice of
`docs/spec-items/trident-build-efficiency.md`, not completion of its deployed
benchmark or live acceptance criteria.

Fresh terminal `single` and `task_sequence` workers now perform stage 1. Host
review runs the full suite, and publication consumes the existing durable
receipt under its unchanged owner, revision, round, strategy, dependency,
toolchain, and workspace identity. Intermediate task-sequence handoff still
returns before review. Wave members and bound-review workers retain their
worker full-suite obligation because they do not follow the terminal
implementation path. No second cache was added.

New briefs use version 3. Reconstruction preserves every already-admitted v2
brief path and byte, including roles other than the pending worker. Later v2
fix turns retain their original full-suite instructions. The original legacy
brief/schema migration still validates every other routing and authority field.

Host red findings now carry the exact log and bounded diagnostic tail to the
fix worker. A stage-1 claim cannot explain an unrelated host red. A new
host-suite worker can earn the existing G065 advisory only after a same-run fix
dispatch receives prior host-red diagnostics and supplies targeted base
comparison evidence. The host chooses Bun parsing from command/runner bytes;
complete named failures and error signatures form an identity independent of
round, revision, log path, and durations. Missing summaries, additional module
crashes, or incomplete output cannot use the generic-runner exemption. Other
runners retain the existing reviewer-adjudicated comparison contract: the host
does not claim to semantically validate arbitrary runner output. Legacy
full-suite workers retain their admitted G065 contract. Empty evidence and
every panel veto continue to block.

Stable suite finding identities feed G070 separately from changing diagnostic
paths and tails, so a repeated host failure still requires arbitration when
other panel findings disappear.
Generic or unparsed failures explicitly carry unknown identity. Their first red
can receive a fix, and green or earned advisory evidence can proceed. Unresolved
later red retains G071's readable-count stops; falling counts with unknown
failure identity remain undecidable under G072, never invented repetition or
proof of improvement.

Consuming coverage in `open/__tests__/project-build-e2e.test.ts` counts one host
suite across terminal review and publication, two suites across a code-fix
round, and fresh acquisition after changed revision, strategy, dependencies,
runtime, or workspace. It also covers same-round cached red, intermediate and
wave siblings, whole-map v2 pending recovery, actual targeted base-test
execution, generic-runner evidence, changed failure/run, mixed Bun crashes,
empty evidence, panel veto, and repeated-failure arbitration. Focused coverage
includes `trident/build-run.test.ts`, `trident/project-build-host.test.ts`,
`trident/gates/review-suite.test.ts`, `trident/gates/review-progress.test.ts`, `trident/suite-failure.test.ts`,
`trident/test-strategy.test.ts`, and Open wiring tests.

Offline validation: the complete consuming Open file passed 286 tests. The
seven focused files passed 536 tests. Both root and Trident
TypeScript checks passed, and `scripts/ci/typecheck-all.sh` passed all 51
projects. Semantic mutations were rejected in both directions for G065
(unearned advisory admitted / earned advisory rejected) and G070 (changing
diagnostics hide recurrence / every failure falsely treated as repeated).
Separate consuming mutations also reject dropping the wave worker suite and
restoring the redundant terminal worker suite. G072 mutations reject inventing
progress from missing identities and refusing a resolved green/advisory round.
Restored controls pass. The generic unchanged/changed-red consumers return
unknown rather than fabricated repetition, while the earned generic advisory
still merges.

The host suite still completes before the independent review panel. This
change neither establishes concurrent proof/review timing nor claims token or
cost savings. The broad efficiency item remains open pending deployed proof.
