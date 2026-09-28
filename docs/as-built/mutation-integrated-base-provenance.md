## 2026-09-28 — Preserve the observed integration base for mutation proof

An ancestry-preserving base refresh still measured mutation targets from the
launch SHA. Upstream production integrated by the fix therefore looked like
candidate-owned production, blocking a documentation/test change without a
mutation nomination. The consuming regression reproduced that exact refusal.

The settled fix now retains its host-observed base, original candidate, resulting
head and PR number in the existing checkpoint after both ancestry checks
(`trident/build-run.ts:765`, `trident/build-run.ts:805`). The mode-state reader
can recover the same provenance for older terminal FIX checkpoints only from the
immediately preceding authenticated integration reservation
(`trident/build-mode-state.ts:78`). Existing retry import then carries completed
work forward without another planner, builder or fixer dispatch. Historical
events and the launch SHA remain unchanged.

Before and after mutation proof, the publication host checks the actual PR's
identity and exact base OID, both integration ancestors, the current candidate's
descent from the integrated head, and checkpoint stability
(`trident/gates/mutation-base.ts:6`, `trident/build-host.ts:181`). Only that
verified base scopes the normal mutation prover; its expected head, readable
nonempty diff, nomination, target and argv requirements still apply. Missing
provenance retains the launch range; malformed or moved provenance refuses.
This implements the observed-base recovery acceptance in
`docs/spec-items/trident-build-efficiency.md:169` under the locked pivot's
“Keep the gates” ruling and G141–G143. The earlier launch-pin record remains
immutable history; ordinary unintegrated builds still use that launch pin.

Validation: 687 tests passed across build-host, build-run, cross-run retry and
production-host-effects suites. The nine bounded consuming base-drift scenarios
passed, including same-run integration, terminal FIX retry, genuine candidate
production refusal, task-budget preservation and existing binding/ceiling
controls. Fourteen focused publication controls cover valid, absent, forged,
moving and unreadable provenance, PR identity, ancestry and checkpoint changes.
The historical fixture also rejects missing/corrupt reservation provenance.
Root and Trident TypeScript checks, changed-file lint and whitespace validation
passed.

Bidirectional semantic mutations were executed and restored. Forcing the launch
range again kills the valid integrated-base case while production and missing
provenance controls remain green. Exempting every integrated change kills the
candidate-production refusal while valid and missing-provenance controls remain
green. Full CI, combined-candidate verification and deployment are separate
integration work; this record does not claim a live retry or merge succeeded.
