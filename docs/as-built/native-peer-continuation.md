## 2026-10-10 — Continue independent native peers without waiting on each other

The fresh task sequence in #1447 passed its repaired candidate's CI and full host
suite, then three concurrently dispatched Claude reviewers hit quota. The parent
queue admitted an original child's continuation past itself but treated every
other bound background child as a blocker. Two compatible paused peers therefore
waited for each other's completion before either could reconcile capacity.
This correction belongs to #1416 and the existing
`docs/spec-items/claude-same-agent-continuation.md` contract.

`runtime/adapters/claude-code/persistent/repl-session.ts:645` now admits a bound
original child's continuation past a compatible peer using the same measured
workspace independence as initial dispatch. The extra bound-child requirement
lives in `runtime/workers/native-child-workspace.ts:142`; an unbound new request
cannot use continuation to jump that fence. Parent input remains serialized,
ordinary queued turns still await live children, and original busy leases remain
held. Cancellation removes a queued continuation without releasing an active
parent slot; cancellation after grant releases only its own slot.

`runtime/workers/claude-native-continuation.ts:269` verifies current original
authority before binding reconstructed workspace ownership or entering the
queue. Receipt, launch, original process, relay, workspace census and budget
checks remain, including rechecks after queue acquisition and before native
input. No replacement child, account override, budget extension or durable lease
release is introduced.

Validation before the complete repository gates: the unchanged base reproduced
all four compatible-peer deadlocks while retaining the unbound-child refusal.
The repaired real-queue and signed-consumer suites passed 96 cases with 427
assertions. They cover two readers, disjoint writers, both mixed orders, a queued
ordinary turn, conflicting paths and branches, verified reconstruction, stale
authority, forged receipts, and cancellation before and after grant. Six source
mutations failed their matching behavioral controls: original deadlock, unbound
bypass, conflicting-peer bypass, orphaned cancelled queue entry, absent recovery
binding, and stale-authority binding. The signed consumer submits once to the
same child and reconciles its exact native invocation without another input.

The complete shared-host gate, exact publication-head CI and live adapter proof
are pending. Focused fixtures do not establish deployed quota recovery or the
remaining unattended task-sequence acceptance. No Trident-owned candidate was
edited or manually merged for this correction.
