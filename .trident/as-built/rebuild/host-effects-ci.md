## 2026-09-15 — Acquire the CI facts required by readiness

### Outcome and vocabulary

The production adapter now acquires classic protection, independent branch evidence,
branch rules, complete base check-run and commit-status name lists, and the PR's
mergeability plus status rollup (`trident/production-host-effects.ts:45`,
`trident/production-host-effects.ts:60`, `trident/production-host-effects.ts:107`).
The source is injectable for scripted observations (`trident/production-host-effects.ts:31`,
`trident/production-host-effects.ts:36`); production defaults to the credentialed
command-backed source (`trident/production-host-effects.ts:285`).

The new outcome joins `CiRunObservation` and `CiReadinessVerdict` as
`configuration-error` (`trident/ci-readiness.ts:9`, `trident/ci-readiness.ts:16`).
The existing merge-gate vocabulary maps only `cannot-read` to unknown and every
other non-green verdict to blocked (`trident/build-host.ts:126`), so the new value
blocks by default. Unknown required-check acquisition becomes unreadable before
rollup classification (`trident/ci-readiness.ts:42`); it cannot become green.

### Gate evidence

G045 combines contexts found in classic protection and branch rules through one
deduplicating collector (`trident/production-host-effects.ts:67`,
`trident/production-host-effects.ts:78`, `trident/production-host-effects.ts:88`).
A classic-protection 404 is distinguished by command outcome and response shape
(`trident/production-host-effects.ts:42`); if neither source nor independent branch
evidence establishes the answer, acquisition returns unknown
(`trident/production-host-effects.ts:96`). The ruleset-only and ambiguous-404
certifications are `trident/production-host-effects.test.ts:87` and
`trident/production-host-effects.test.ts:99`.

G046 requires both producer endpoints to return valid integer totals and exactly
that many string names (`trident/production-host-effects.ts:49`). Either incomplete
list makes `produced` null (`trident/production-host-effects.ts:101`), which disables
the configuration-fault inference (`trident/ci-readiness.ts:58`). The acquisition
and classification certifications are `trident/production-host-effects.test.ts:111`
and `trident/ci-readiness.test.ts:26`.

G048 records app binding while acquiring required entries
(`trident/production-host-effects.ts:69`) and filters an app-bound name to CheckRun
rows during classification (`trident/ci-readiness.ts:51`). Its certification uses
the same name once as a classic status and once as a check run
(`trident/ci-readiness.test.ts:10`). This checks row shape, not the producer's
actual app identity.

G050 seeds settled state from a nonempty rollup and clears it for every unfinished
non-skipped row (`trident/ci-readiness.ts:54`). A configuration stop additionally
requires nonempty complete base evidence, absence of the required name, and elapsed
host grace (`trident/ci-readiness.ts:58`). The production host owns the grace
constant, clock, and first-missing timestamp (`trident/production-host-effects.ts:41`,
`trident/production-host-effects.ts:286`); no worker supplies them. Its four-way
certification is `trident/ci-readiness.test.ts:17`.

G051 reacquires configuration only for a tentative configuration error and
reclassifies only when the fresh acquisition resolves (`trident/production-host-effects.ts:299`,
`trident/ci-readiness.ts:69`). Its certification changes the required name between
the tentative and fresh snapshots (`trident/ci-readiness.test.ts:31`).

The invariant is maintained on every production CI observation: the host acquires
configuration and rollup together, checks the rollup head, classifies, and performs
the conditional fresh acquisition (`trident/production-host-effects.ts:288`). It
does not depend on a worker remaining available because acquisition runs through
the host runner (`trident/production-host-effects.ts:46`).

### Mutation evidence

Every mutation below compiled with `bunx tsc --noEmit -p trident/tsconfig.json`,
printed the changed source line, produced the listed runtime RED, and was restored
before the bounded suite passed.

| Gate | Compiling permissive mutation | Printed line | Runtime RED |
| --- | --- | --- | --- |
| G045 | Ignore every `required_status_checks` rule | `trident/production-host-effects.ts:91` | `G045 ruleset requirements survive a classic-protection 404` |
| G046 | Accept a producer array whose length differs from `total_count` | `trident/production-host-effects.ts:54` | `G046 truncated producer lists are unreadable evidence` |
| G048 | Admit StatusContext rather than CheckRun for an app-bound name | `trident/ci-readiness.ts:52` | `G048 app-bound requirement rejects a classic status row` |
| G050 | Replace the grace comparison with `elapsedMs >= 0` | `trident/ci-readiness.ts:59` | `G050 configuration fault requires grace, base evidence, and a settled nonempty rollup` |
| G051 | Return the tentative error instead of reclassifying fresh configuration | `trident/ci-readiness.ts:72` | `G051 fresh resolved configuration reclassifies a tentative fault` |

### Validation and limits

The bounded command enumerated exactly
`trident/production-host-effects.test.ts`, `trident/project-build-host.test.ts`, and
`trident/ci-readiness.test.ts`: 70 pass, 0 fail, 279 assertions. Both
`bunx tsc --noEmit -p trident/tsconfig.json` and `bunx tsc --noEmit` passed.
`bash scripts/ci/lint.sh` and `git diff --check` passed. The package-script search
finds `test:bun` at `package.json:61` as its positive control and no typecheck
script, so the compiler commands above were used.

No network was available, so live acquisition is unproven. The proving sequence is
to run the five `gh api` paths at `trident/production-host-effects.ts:61` against
the base branch and `gh pr view --json headRefOid,mergeable,statusCheckRollup` at
`trident/production-host-effects.ts:109` against a real PR, then confirm the
ruleset-required `test` row reaches the resolved configuration. The scripted tests
cover success, truncation, absence, and error-shaped command observations
(`trident/production-host-effects.test.ts:87`).

No product decision or spec criterion changed. `trident/project-build-host.ts`
needed no edit because it already passes the production observation through to the
build host (`trident/project-build-host.ts:71`). Driver files, launcher cutover,
cleanup behavior, pagination beyond the guarded count mismatch, and actual app
identity verification were deliberately not changed.
