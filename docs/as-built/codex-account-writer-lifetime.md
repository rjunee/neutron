## 2026-10-04 — Native Codex processes retain account writer admission

Sharing one credential pathname does not serialize refreshes made by separate
native processes. The account writer primitive now takes a nonblocking exclusive
reservation lock on a permanent account-local inode before probing a separate
process-associated native lock and inspecting existing native
consumers (`runtime/adapters/codex-cli/account-writer-lock.ts:32`). Busy and
unavailable admission remain distinct visible errors. Credential service callers
can use the same short lease around their existing writes.

The native transport transfers the lease through descriptor 3 and closes only
its own descriptor (`runtime/adapters/codex-cli/persistent/project-control-broker-transport.ts:33`).
The Python launcher acquires a POSIX process-associated record lock on a
dedicated permanent inode while the inherited reservation remains held, then
releases and closes that reservation before executing the native writer in
place (`runtime/adapters/codex-cli/account-writer.py:206`). The official
npm entrypoint is resolved to its packaged executable because its JavaScript
child-process wrapper does not pass this extra descriptor. The resulting native
PID, process birth identity, working directory and streams survive that exec.
Neither helper death nor gateway death releases a still-running native writer's
process lock. It survives exec but is not inherited across fork: a shell or MCP
descendant can retain the descriptor without retaining native admission after
the writer exits. These are the documented [Linux process-lock semantics](https://man7.org/linux/man-pages/man2/fcntl_locking.2.html).
Parents only close their reservation descriptors; only the launcher releases
the reservation after it owns the process lock. No release unlinks either inode.

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
Fourteen guard tests pass, including two simultaneous admissions, distinct accounts,
canonical aliases, reserved-lease home binding, native survival after gateway
SIGKILL, independent kernel lock contention, and release after exact native exit
while an execed tool remains alive with the same inode open. A paused handoff
proves admission remains reserved until the process lock is acquired. A separate
non-Codex record-lock holder proves credential admission checks that lock even
when the native census cannot supply the refusal.
The Bun suite also invokes seven synthetic process-census cases. Root and Trident
TypeScript checks pass. Existing execution/environment and interactive session
controls pass; the account-probe and native retirement controls pass.
The descendant-lifetime correction passed 22 focused guard, transport and probe
tests with 95 assertions, plus both TypeScript checks.
Before the descendant-lifetime refinement, the launch-path consuming run of `trident/codex-build.test.ts`,
`trident/codex-review.test.ts`, and `open/__tests__/project-build-e2e.test.ts`
completed with 757 passing tests, zero failures, and 8,382 assertions.
Admission mutation controls reject a shared reservation and unconditional busy
refusal. The lifetime controls inspect process-lock exclusion independently of
both the reservation and census; a descriptor count alone cannot establish it.
Three correction mutants were killed: retaining the inherited reservation after
exec leaves a successor busy while the tool lives; omitting the process lock
leaves the native writer unprotected; releasing the reservation before acquiring
the process lock admits through the paused handoff. All three restored controls
pass.

This is Linux admission using the existing Bun server and Python runtime, not a
new credential authority. The verified lifetime profile is the direct native CLI
or its recognized official npm package. Arbitrary custom wrapper executables are
not attested: they may close inherited descriptors or spawn another writer that
does not inherit them, and deployment must not claim those wrappers are protected.
Its cooperative boundary is explicit: later direct
launches outside these entrypoints can bypass advisory locking. Deployment must
inventory and route every actual writer before claiming account-wide exclusion.
These synthetic results do not establish live migration or token freshness, and
no live credential or refresh experiment was performed for this change.
