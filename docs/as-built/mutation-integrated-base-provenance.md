## 2026-09-28 — Preserve the observed integration base for mutation proof

An ancestry-preserving base refresh still measured mutation targets from the
launch SHA. Upstream production integrated by the fix therefore looked like
candidate-owned production, blocking a documentation/test change without a
mutation nomination. The consuming regression reproduced that exact refusal.

The settled fix now retains its host-observed base, original candidate, resulting
head and PR number in the existing checkpoint after both ancestry checks
(`trident/build-run.ts:771`, `trident/build-run.ts:811`). The mode-state reader
can recover the same provenance for older terminal FIX checkpoints only from the
immediately preceding authenticated integration reservation
(`trident/build-mode-state.ts:78`). Existing retry import then carries completed
work forward without another planner or builder dispatch. Historical
events and the launch SHA remain unchanged.

Before and after mutation proof, the publication host checks the actual PR's
identity and exact base OID, both integration ancestors, the current candidate's
descent from the integrated head, and checkpoint stability
(`trident/gates/mutation-base.ts:6`, `trident/build-host.ts:181`). Only that
verified base scopes the normal mutation prover; its expected head, readable
nonempty diff, nomination, target and argv requirements still apply. Missing
provenance retains the launch range; malformed or unreadable provenance refuses.
This implements the observed-base recovery acceptance in
`docs/spec-items/trident-build-efficiency.md:169` under the locked pivot's
“Keep the gates” ruling and G141–G143. The earlier launch-pin record remains
immutable history; ordinary unintegrated builds still use that launch pin.

Pre-merge review rejected the first candidate because recovered terminal FIX
state omitted the original worker-input bindings. The corrected importer shares
the existing completed artifact and four-brief authenticator with merge-stop
recovery (`trident/build-mode-state.ts:255`) and returns those bindings through
the existing retry policy guard. Changed model, effort or reflection instructions
refuse reuse; an unchanged further retry retains the bindings.

A second regression reproduced deployment advancing main beyond the previously
integrated base. The corrected publication observation verifies a forward base
advance, exact fetched PR base, assessable diff and stable remote identity before
requesting the existing bounded integration fix
(`trident/gates/mutation-base.ts:32`, `trident/build-run.ts:1091`). This applies
to both overlapping and disjoint advances of an already integrated base. It does
not exempt the new candidate: both ancestries, fresh mutation proof, suite and
review remain required, and the existing round ceiling remains charged.

Validation: 687 tests passed across build-host, build-run, cross-run retry and
production-host-effects suites. The sixteen bounded consuming base-drift scenarios
passed, including same-run integration, terminal FIX retry, genuine candidate
production refusal, task-budget preservation and existing binding/ceiling
controls. Sixteen focused publication controls cover valid, absent, forged,
moving and unreadable provenance, PR identity, ancestry and checkpoint changes.
The historical fixture also rejects missing/corrupt reservation provenance,
changed worker inputs and a missing actual PR base; both kinds of forward base
advance reach fresh proof and review without repeating completed task work.
Additional driver and publication controls reject a supplied previous-base pin
that is mutable or equal to the current base, even when overlap is nonempty.
Root and Trident TypeScript checks, changed-file lint and whitespace validation
passed.

Bidirectional semantic mutations were executed and restored. Forcing the launch
range again kills the valid integrated-base case while production and missing
provenance controls remain green. Exempting every integrated change kills the
candidate-production refusal while valid and missing-provenance controls remain
green. Dropping recovered worker bindings kills the changed-model refusal while
unchanged retry still passes. Omitting forward-base refresh kills the disjoint
advance case while unchanged and unknown-base controls still pass. All mutants
were restored. Full CI, combined-candidate verification and deployment are separate
integration work; this record does not claim a live retry or merge succeeded.
