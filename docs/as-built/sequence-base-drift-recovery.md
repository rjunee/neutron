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
(`trident/build-mode-state.ts:163`). Admission requires the canonical blocked merge
result, identity-valid build/review/approved event sequence, terminal plan,
settled attempt census including synthesis, original build artifact and intact
worker briefs. The imported stage is `built`, never `approved`. Production
preparation compares the original worker model, authority and brief bindings.
Original evidence is retained in place; it is not relabelled as a new receipt.

Measured locally against the implementation based on `5943caf5e`:

- The focused driver, build-host and cross-run retry files pass 528 tests.
- Six `base drift refresh` consuming E2E cases pass: current-run repair,
  historical terminal recovery, exhausted budget, changed model, changed policy
  and changed brief. The historical case includes malformed/source-identity,
  head, pending, veto, task-remainder and unsettled/missing-synthesis controls.
  Real Git proves the repaired candidate contains both prior heads; the new
  review is round two, with no repeated planner or builder.
- Root and Trident TypeScript checks pass separately.
- A read-only probe of the original failed sequence run admits only its completed
  build at the original head, round one and task iteration two, with worker
  bindings retained. Original records remain unchanged and a foreign identity
  is refused. This is source-eligibility evidence, not a live retry or merge.

The complete consuming E2E file, semantic mutation controls and publication
checks are recorded with the final validation receipt. Deployment and an
unattended live retry remain separate acceptance evidence.
