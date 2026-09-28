## 2026-09-28 — Refresh completed candidates after measured base drift

The observed sequence candidate and an independently landed change both touched
`open/__tests__/project-build-e2e.test.ts`. The graph's merge base remained the
original launch revision. G108 correctly refused their unreviewed interaction;
the missing behavior was recovery after that refusal. The design retains G107
and G108 (`docs/trident-gates-inventory.md:214`), the locked plan's instruction to
repair the loop while keeping its gates, and the completed-work recovery contract
in `docs/spec-items/trident-build-efficiency.md`.

`trident/gates/release-readiness.ts:286` still refuses overlap, now carrying the
host-observed candidate, actual PR base, base OID and overlapping paths. The driver
uses only this typed observation to purchase a bounded fix; an unknown observation
or human error string cannot grant that authority. The worker merges the observed
base into the candidate, and the host verifies both ancestors independently
(`trident/build-run.ts:757`). The observed blocker, pending request and review
round remain durable through recovery. A changed candidate obtains fresh
publication proof, full-suite evidence and review before the pinned merge gate.
Task iteration and the finite review ceiling are retained.

An already terminal merge refusal can import its preceding completed build
(`trident/build-mode-state.ts:169`). Admission requires the canonical blocked merge
result, identity-valid build/review/approved event sequence, terminal plan,
settled attempt census including synthesis, original build artifact and intact
worker briefs. The imported stage is `built`, never `approved`. Production
preparation compares the original worker model, authority and brief bindings.
Original evidence is retained in place; it is not relabelled as a new receipt.

Measured locally against the implementation based on `5943caf5e`:

- The focused driver, build-host and cross-run retry files pass 529 tests,
  including original-request recovery of a pending base fix and both ancestry pins.
- Seven `base drift refresh` consuming E2E cases pass at task iteration two: current-run repair,
  historical terminal recovery, exhausted budget, changed model, changed policy
  changed brief, and retained worker bindings after a preparation-only retry
  failure. The historical case includes malformed/source-identity,
  head, pending, veto, task-remainder and unsettled/missing-synthesis controls.
  Real Git proves the repaired candidate contains both prior heads; the new
  review is round two, with no repeated planner or builder.
- Root and Trident TypeScript checks pass separately.
- A read-only probe of the original failed sequence run admits only its completed
  build at the original head, round one and task iteration two, with worker
  bindings retained. Original records remain unchanged and a foreign identity
  is refused. This is source-eligibility evidence, not a live retry or merge.

Semantic mutation controls ran in a separate worktree at `237bbb40b`: changing
G108 overlap to allow fails its refusal test; suppressing the driver repair fails
the legitimate recovery test; refusing all approved-source imports fails the
historical consuming test. All three mutants were killed, and the restored tree
has no diff and passes the positive unit controls.

The complete `bun test open/__tests__/project-build-e2e.test.ts` invocation passed
411 tests and 5,500 assertions in 600.53 seconds. It began on the initial
implementation, before the later pending-fix and binding-chain controls; that
result does not claim to validate the later edits. After those edits and original
attempt identity tightening, the three focused Trident files pass 529 tests and
2,751 assertions; `bun test open/__tests__/project-build-e2e.test.ts -t 'base drift
refresh'` passes seven cases and 81 assertions. Both `bunx --no-install tsc -p
tsconfig.json --noEmit` and its `trident/tsconfig.json` counterpart pass again.

The final publication gate must validate the frozen candidate. Deployment and an
unattended live retry remain separate acceptance evidence.
