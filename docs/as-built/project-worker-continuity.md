## 2026-09-23 — Durable ownership for recurring cross-provider worker threads

The recurring-work acceptance in `docs/spec-items/trident-build-efficiency.md`
requires the host to retain an observed conversation across plan/build/fix calls,
scoped to run, project, role, provider, model and credential identity. The locked
design, `docs/plans/harness-orchestrator-pivot-2026-09-11.md` §3.2–3.3, prescribes
native same-provider subagents and one-shot cross-provider calls that resume the
previous thread.

`trident/project-worker-continuity.ts` supplies the host-side wrapper. It stores
the ownership digest and observed thread atomically, records each step's original
requested thread for adapter recovery, and holds an exclusive writer lock during
the turn. A separate run-directory initiation witness prevents deletion of the
whole role directory from turning a follow-up into a fresh conversation. Recovery
identity excludes regenerated filenames and remaining wall budget, while retaining
the adapter's reservation directory and meaningful work inputs. Missing or corrupt receipts, changed ownership, foreign thread claims,
uncertain previous steps and overlapping writers refuse further dispatch. A
leftover lock after an unobserved process death stays uncertain; this module does
not authorize taking it over. Credentials themselves are never stored. Native
same-provider calls and separate review/synthesis threads bypass this binding;
the adapter's unsupported-capability outcomes remain intact.

The real Codex headless adapter test observes initial thread creation, reconstructs
the wrapper and adapter, recalls the original step without another dispatch, and
then checks that the next step receives the observed thread. Other tests cover
both native placement directions, unsupported Claude build/fix, every ownership
dimension, same-step and different-step overlap, credential changes during a
turn, missing/corrupt/symlink/oversized receipts, and recovery positive controls.
The focused continuity and existing adapter suites pass 131 tests; both root and
Trident TypeScript checks pass. Seven semantic mutations fail their intended
assertions: always creating a fresh thread, weakening ownership scope, removing
writer exclusion, applying the wrapper to native/review work, and accepting an
unobserved thread, binding regenerated transport coordinates, and recreating a
missing role directory. Restoring the guards passes all 23 continuity tests. Independent
review found the regenerated-coordinate and missing-role-directory cases; both
now have regression tests through the real Codex adapter.

This slice is the binding module and adapter-level verification. Production
composition in `open/wiring/project-build.ts`, its consuming
`open/__tests__/project-build-e2e.test.ts` proof, and deployed live-run measurement
remain required before the recurring-work acceptance or P0 efficiency issue can
be considered complete.
