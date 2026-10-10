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

A live ephemeral turn through `createClaudeCodeSubstrateAuto` on the retained Bun
host and registered native relay returned its exact requested marker at 04:54 UTC
using the candidate runtime from `ffa3ee76dc08f5c4ed9da5cf126c3e3383548c6a`.
The native aggregate reported 97 output tokens and 5,167 cache-creation input
tokens; provider-message deduplication was unavailable for that proof. This proves
the adapter turn, not same-child quota continuation in production. An initial
probe was refused locally before spawn because its sink port requested an
unsupported ephemeral port; the successful probe used a separate fixed port.

The first canonical shared-host gate passed lint but found the peer test helper's
inferred session type lacked `acquireTurn`; it stopped before the full suite.
The helper now accepts the actual `ReplSession` fixture, and the runtime typecheck
passes. Production code is unchanged by that correction. The complete shared-host
gate and exact publication-head CI remain pending. Focused fixtures do not
establish deployed quota recovery or the remaining unattended task-sequence
acceptance. No Trident-owned candidate was edited or manually merged.
