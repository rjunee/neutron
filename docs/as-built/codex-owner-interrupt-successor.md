## 2026-09-19 — Reuse the Codex owner after an acknowledged interruption

The locked long-lived project conversation (`SPEC.md:626`, pivot plan §3.1)
must survive an ordinary owner interrupt. The observer previously threw on
every native `turn_aborted`; the conversation wrapper and owner lease then
quarantined the project, even after the interrupt API acknowledged the exact
turn. The old consuming fixture emitted `task_complete` on interrupt and did
not assert that the successor completed.

`runtime/adapters/codex-cli/persistent/rollout-observer.ts:293` now recognizes a
distinct interrupted terminal only with the exact delivery receipt, prompt
echo and no unresolved native children. It emits an aborted error, never a
completion. The conversation wrapper passes that distinct outcome to its
lease. `open/wiring/codex-owner-controls.ts:158` awaits the original owner's
interrupt acknowledgement, and `open/wiring/codex-owner-binding.ts:172` admits
reuse only for that acknowledged interruption outside build work after the
broker settles idle. Unknown delivery, unsolicited aborts, wrong identities,
pending children and build cancellation retain reconciliation fences.

`open/__tests__/codex-owner-binding.test.ts:895` exercises the authenticated
control and model surfaces plus the owner chat SessionHandle. Local and remote
interrupts produce aborted errors, preserve model reads, clear durable work
markers and permit the next chat to complete in the same thread. The negative
cases at line 922 preserve the durable marker and refuse reuse after restart.
The native transport is a fixture; this is not a live CLI interruption smoke.

Validation: 141 owner-binding and rollout-observer tests pass; root and Trident
TypeScript checks pass. A mutation restoring unconditional abort refusal fails
both healthy interrupt cases. A mutation dropping the acknowledgement condition
fails the unsolicited-abort model API assertion (200 instead of 503). Both
mutations were reverted. The documentation search found the older cancellation
caveat in `codex-native-owner-controls.md`; that historical record remains
accurate for uncertain cancellation and is not rewritten.
