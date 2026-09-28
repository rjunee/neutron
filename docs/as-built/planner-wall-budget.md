## 2026-09-28 — Give bounded planning a thirty-minute wall

The planning role's host wall increases from fifteen to thirty minutes in
`trident/project-build-budget.ts`. Review remains fifteen minutes; build and fix
remain ninety minutes. The existing deadline, outcome validation, dispatch
reservations and child ownership mechanisms are unchanged.

The observed planning attempt spent over eight minutes investigating and preparing
a reconciliation before starting the complete consuming test file with a
560-second command timeout. Its separate focused checks and typecheck matrix
completed, but no validated plan result was observed before the original host
wall. Slow project REPL probes need room to finish; this is a bounded allowance,
not proof that the particular attempt would complete within thirty minutes.

This mitigation does not prevent speculative acceptance testing in planning,
authorize that testing, enforce per-command budgets, or stop an unobserved child.
An expired observation still cannot establish completion or cancellation. The
planner work boundary and all builder, proof, review and publication gates remain.
The existing efficiency spec now states the exact role ceilings and these limits.

The production wiring regression pins all four role budgets. The consuming hung
submission, acquisition and silent-worker cases first assert the production
thirty-minute budget, then shorten only its duration to exercise actual finite
deadline enforcement, unknown outcomes and retained ownership without a long wait.

Validation: the focused production wiring and consuming deadline selection passed
5 tests (422 filtered out), covering all three hung seams and successful native
completion within the wall. The restored complete wiring file passed 51 tests
with its local socket fixture permitted (the sandbox-only attempt denied that
fixture's listener). Both `tsc -p tsconfig.json --noEmit` and
`tsc -p trident/tsconfig.json --noEmit` passed. Semantic mutations independently
restoring the fifteen-minute plan wall, increasing review to thirty minutes, and
making the plan wall infinite each failed the exact production role-budget test;
all mutations were restored. The broader local wiring/consuming run was interrupted
to prioritize focused proof; it is not a passing full-file receipt. Exact-head CI
must provide the complete consuming-file and suite proof before merge.
