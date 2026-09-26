## 2026-09-26 — Bound Codex recovery authority fixture requests separately

Audit #1298 investigated a recovery-authority success fixture failing during
PR #1322 CI. The historical assertion reported only `kind: failed`; its failure
class was not captured, so this change does not claim that failure was a proven
timeout.

The two review/synthesis recovery-authority cases now use a bounded 10-second
fixture request budget for their real fake-CLI setup and recovery calls, with a
15-second test deadline (`runtime/workers/codex-review.test.ts:105-148`). Their
initial assertion matches the completed kind against the full returned object,
exposing the failure class and detail in diagnostics if setup fails again. Snapshot
and one-call assertions still exercise absent, foreign, corrupt and lost
dispatch authority, and committed receipt recovery still equals the successful
turn. The fixture default remains 2 seconds (`:97`); the explicit timeout
case retains 80 milliseconds (`:413-418`). Production code is unchanged.

A temporary 2.2-second shell startup delay before the fixture's Node CLI made
both old 2-second setup turns fail with `class: timeout` and wall-clock-budget
detail (about 2.02 seconds each). With only these two request budgets changed,
the same delayed CLI completed both cases: 2 tests, 40 assertions, approximately
2.27 and 2.29 seconds. The temporary delay was removed from the delivered diff.
This proves a bounded setup sensitivity, not the historical CI cause.

Semantic mutation controls failed as expected: replacing recovery reservation
reading with ordinary reservation creation caused missing-authority recovery
to return completed; refusing every existing reservation rejected legitimate
committed receipt recovery; removing timeout classification changed the explicit
80-millisecond case to infra. All mutations were removed. The restored focused
file passed 48 tests and 316 assertions. Root and trident TypeScript projects
both passed `bunx tsc --noEmit -p` checks. These controls preserve the budget and
bidirectional guard requirements in
`docs/spec-items/trident-build-efficiency.md:190-201` and failure attribution
requirements in `:100-115`.

After the focused diagnosis, the canonical shared-host wrapper passed at source
commit `bdb49f4a5d7db8fed4b21f25ba039e555de224cb`, tree
`4ad863dc908abe05edfa2a716fbbcdee96e52d06`: all 51 TypeScript projects and all
1,693 test files across 18 lanes passed, with coverage accounting for 1,459
general, 22 PGLite, 43 device and 169 real-HTTP files. The wrapper exited zero;
the source remained unchanged throughout the run. Independent review approved
the focused repair. This receipt changes documentation only.

Clean tracked archives at the parent and source commit produced identical
complete privacy finding sets: 451 rule findings each, zero added and zero
removed. Both baseline tree scans remain red; parity does not establish a clean
public tree. Final source commit messages and the prepared PR title/body passed
the local prepublication gate with zero findings. Authoritative PR CI and purity
remain required. No CI rerun was used to diagnose this fixture.
