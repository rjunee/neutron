## 2026-10-04 — Native Codex processes retain account writer admission

Sharing one credential pathname does not serialize refreshes made by separate
native processes. The account writer primitive now takes a nonblocking exclusive
kernel lock on a permanent account-local inode before inspecting existing native
consumers (`runtime/adapters/codex-cli/account-writer-lock.ts:32`). Busy and
unavailable admission remain distinct visible errors. Credential service callers
can use the same short lease around their existing writes.

The native transport transfers the lease through descriptor 3 and closes only
its own descriptor (`runtime/adapters/codex-cli/persistent/project-control-broker-transport.ts:33`).
The Python launcher makes the descriptor inheritable and executes the native
writer in place (`runtime/adapters/codex-cli/account-writer.py:34`). The official
npm entrypoint is resolved to its packaged executable because its JavaScript
child-process wrapper does not pass this extra descriptor. The resulting native
PID, process birth identity, working directory and streams survive that exec.
Neither helper death nor gateway death releases a still-running native writer's
lock. Release never unlinks the inode or explicitly unlocks a surviving child's
open-file description.

The production execution adapter (`runtime/adapters/codex-cli/exec.ts:150`),
interactive project launcher (`runtime/adapters/codex-cli/persistent/project-session.ts:277`),
build wrapper (`trident/codex-build.sh:1474`) and review wrapper
(`trident/codex-review.sh:543`) now enter through that launcher. Account viability
probes use the guarded native transport. The process census includes existing
unwrapped native consumers, canonicalizes their homes, and refuses incomplete
observations. A scheduler state change alone does not change process identity.
Transient proc reads can retry only by completing a fresh full census while the
account lock remains held.

The synthetic native fixture never reads credentials or accesses the network.
Ten guard tests pass, including two simultaneous admissions, distinct accounts,
canonical aliases, reserved-lease home binding, native survival after gateway
SIGKILL, independent kernel lock contention, and release after exact native exit.
The Bun suite also invokes seven synthetic process-census cases. Root and Trident
TypeScript checks pass. Existing execution/environment and interactive session
controls pass; the account-probe and native retirement controls pass.
The consuming run of `trident/codex-build.test.ts`,
`trident/codex-review.test.ts`, and `open/__tests__/project-build-e2e.test.ts`
completed with 757 passing tests, zero failures, and 8,382 assertions.
Semantic mutation controls reject a shared (rather than exclusive) lock,
unconditional busy refusal, and a descriptor closed by native exec. The restored
exclusive-lock implementation admits the positive control again.

This is Linux admission using the existing Bun server and Python runtime, not a
new credential authority. Its cooperative boundary is explicit: later direct
launches outside these entrypoints can bypass advisory locking. Deployment must
inventory and route every actual writer before claiming account-wide exclusion.
These synthetic results do not establish live migration or token freshness, and
no live credential or refresh experiment was performed for this change.
