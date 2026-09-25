## 2026-09-25 — Admit independent writable children inside the project REPL

The parent submission mutex previously remained held until a writable child's
result appeared. The host now gives each native child an opaque admission tied
to its durable run/step/generation lease, exact session object and complete
request. It measures the assigned linked Git worktree, branch, canonical paths,
Git directory and filesystem identity before granting overlap
(`runtime/workers/native-child-workspace.ts:32`,
`open/wiring/project-build.ts:467`). Request flags, role names and distinct path
spellings cannot supply that authority.

Terminal text/Enter remains serialized. Only unique provider child evidence
matching the complete request and parent session yields the submission slot.
Disjoint admitted writers then overlap, as do admitted readers; conflicting
writers and ordinary turns wait. Sibling admissions finish their workspace
measurements within the original request budget before dispatch, while unknown
or foreign durable leases remain a fence
(`runtime/workers/claude-acting-turn.ts:233`). No headless same-provider route or
new budget is introduced. These checks govern scheduling; the existing harness
tool and workspace grants still govern the child's task.

The child retains its busy lease through timeout, cancellation and lost
acknowledgement. Validated terminal evidence releases the original durable lease
and its local ownership, including through a reconstructed runner. Ordinary pool
turns also refuse unresolved durable children when a restarted process has no
local waiter. The exact-scope census exposes run, step and generation only;
General, a named project called `general`, and different owners remain separate.

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

The repository-wide suite and live deployment are outside this change's local
verification; this record does not claim a deployed throughput measurement.
