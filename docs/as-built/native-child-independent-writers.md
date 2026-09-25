## 2026-09-25 — Admit independent writable children inside the project REPL

The parent submission mutex previously remained held until a writable child's
result appeared. The host now gives each native child an opaque admission tied
to its durable run/step/generation lease, exact session object and complete
request. It measures the assigned linked Git worktree, branch, canonical paths,
Git directory and filesystem identity before granting overlap
(`runtime/workers/native-child-workspace.ts:32`,
`open/wiring/project-build.ts:477`). Request flags, role names and distinct path
spellings cannot supply that authority.

Terminal text/Enter remains serialized. Only unique provider child evidence
matching the complete request and parent session yields the submission slot.
Disjoint admitted writers then overlap, as do admitted readers; conflicting
writers and ordinary turns behind bound children wait. Sibling admissions finish their workspace
measurements within the original request budget before dispatch, while unknown
or foreign durable leases remain a fence
(`runtime/workers/claude-acting-turn.ts:233`). No headless same-provider route or
new budget is introduced. These checks govern scheduling; the existing harness
tool and workspace grants still govern the child's task.

The runner forwards one absolute dispatch deadline and its cancellation signal
through host preparation into the acting turn. Git measurements receive only the
remaining budget; expiry checks before and after preparation prevent a delayed
measurement from dispatching after the caller returned unknown
(`runtime/workers/claude-in-repl.ts:75`, `open/wiring/project-build.ts:400`).
The durable request reservation remains the recovery identity, never a second
permission to dispatch.

The child retains its busy lease through timeout, cancellation and lost
acknowledgement. Validated terminal evidence releases the original durable lease
and its local ownership, including through a reconstructed runner. Ordinary pool
turns also refuse unresolved durable children when a restarted process has no
local waiter. The exact-scope census exposes run, step and generation only;
General, a named project called `general`, and different owners remain separate.

Adversarial review of the integrated candidate found two liveness mistakes.
A submitted child with no binding or terminal evidence retained its durable
lease correctly, but also held the in-process queue forever. The queue now
unwedges into an explicit refusal: the unknown lease is never released or
eligible for redispatch, and the next child cannot claim independent ownership
(`runtime/adapters/claude-code/persistent/repl-session.ts`,
`runtime/workers/native-child-workspace.ts`). A unique child admitted by this
boot but still preparing has not written to the REPL, so ordinary chat may take
its queued slot; the exception ends synchronously immediately before a possible
submission, not on the later acting-turn unwind. Duplicate, submitted,
ambiguous and previous-boot leases remain refusals. The exception applies only
to chat: eviction, model control, adoption and `/clear` reset continue to see
every unresolved lease (`gateway/project-admission.ts`,
`runtime/adapters/claude-code/persistent/native-child-liveness.ts`,
`runtime/adapters/claude-code/persistent/context-reset.ts`). Both user reset
and periodic sweep consume the guarded reset actuator.

Verification includes the real consuming
`open/__tests__/project-build-e2e.test.ts` barriers: two independent writable
children held concurrently, simultaneous admissions, aliased worktrees remaining
serialized, and lost acknowledgement recovered without another child. The four
existing standalone/panel review barriers preserve all vetoes. Dedicated runtime
tests reject forged, metadata-only, duplicate and wrong-session child evidence,
and cover unknown ownership plus legitimate readers and ordinary successor turns.
Both root and Trident TypeScript checks passed. Semantic mutants forcing serial
execution, admitting aliased worktrees, accepting metadata as child proof,
dropping unknown ownership and bypassing the durable census fail assertions.
Barrier-driven preparation tests also preserve legitimate within-budget dispatch
while rejecting dispatch after expiry or cancellation; deadline mutants cover
both over-admission and over-refusal.

Follow-up controls cover lost acknowledgement and acknowledged-but-unbound
submission, a bounded next queue turn, legitimate local preparation, duplicate
and previous-boot refusals, strict global liveness, and `/clear` refusal while
unknown followed by a permitted reset after reconciliation. Disabling unknown
unqueueing, bypassing an unresolved lease, or dropping the chat preparation
exemption each turns a relevant test red; marking every bound child ambiguous
breaks alias serialization, and weakening global liveness breaks model-control
checks. The exact callback runs before `submitLine`; pre-submission refusal does
not end the preparation exemption early.

The exact integrated code-and-test head `1b903c8f` passed the shared-host gate:
all 51 TypeScript configurations, all 1,686 discovered test files, and all 18
bounded-memory lanes. The first full gate on `66e918f17` was red in the
build-wiring and boot-adoption fixtures. Their linked-worktree/request-identity
and test-owned liveness-query repairs were verified through the real consuming
Open E2E and HTTP lanes in the green gate. This as-built update follows the
tested head; CI must still check the final PR revision. Live deployment and a
throughput measurement remain outstanding.

The first hosted CI pass found two final-head gaps after that host receipt. Lint
rejected a bare voided completion continuation; the named fire-and-forget
observer now records any rejection while preserving lease release. A consuming
E2E asserted that a hung turn acquisition always reports unknown, but the
pre-submission refusal and outer unknown timers share the same deadline and
either may win. The revised control requires one acquisition, zero submissions,
no PR, and eventual exact lease release for that seam. Post-submission hangs
still require unknown and retain ownership; an in-time plan remains a positive
control. Four focused E2E tests, 105 native-child/acting-turn tests, both
TypeScript checks, and lint passed locally. Opposing over-/under-admission
mutants each turned the relevant control red; restored tests passed. The final
hosted CI rerun is still required.
