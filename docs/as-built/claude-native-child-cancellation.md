## 2026-10-10 — Cancel the original native child without replaying work

A stopped run could leave its in-process driver waiting for the worker budget,
and ending that wait did not itself stop the native Claude child. The launcher
now observes durable stop state and aborts its driver. The production worker
wrapper and terminal-dispatch reconciler request cancellation only for the
original signed child after an explicit stop or its original signed deadline.

The native cancellation actor checks the original lease, process birth identity,
launch profile, assigned workspace and armed result reservation. It uses the
existing parent turn queue and `TaskStop` grant. The database records its intent
before input; one request gets at most one submission attempt, even when the
terminal acknowledgement is lost. Only the linked native tool result for that
child releases its exact lease. A native result observed after restart can
complete the same transaction without a live parent. The spent claim remains
and refuses readmission or quota continuation. Valid worker results retain their
existing completion path. Stopped recovery first matches the original armed
reservation and reads its bounded regular result file. An already valid original
result releases its ownership without spending a cancellation turn; a changed
request or result path cannot select another result or release the original lease.

Missing or unsupported native evidence retains ownership. Cancellation spends a
parent control turn and depends on that parent's provider capacity. Existing
parents lacking the launch-time tool grant cannot use this path. No parent
termination, transcript mutation, fabricated worker result, or automatic retry
is authorized by this change. Live unattended cutover acceptance remains open.

Validation covers the real cancel route, launcher, production runner wrapper,
migrated admission database and parent-session queue with simulated native tool
results; the focused fixture does not call a paid provider. Separate runtime
controls reject queued text, wrong identities, tool errors, missing linkage,
duplicate invocation, a rewritten transcript prefix and unavailable tool grants.
The installed native CLI tool contract was separately measured against a local
provider fixture: successful TaskStop aborted the child before the parent turn
finished and produced the linked result shape consumed here. This does not
claim a live production stop or end-to-end cutover pass.

The consuming cancellation regression also fails when durable stop observation
is deliberately disabled: the native cancellation cannot settle. Restoring the
observer restores that behavior.

Focused validation passed five consuming cancellation cases, twelve runtime
cancellation cases, database ownership controls, launcher stop controls, and
project grant/migration regressions. The broader boot-recovery file passed; an
earlier combined invocation had a cleanup timeout and its follow-on error,
retained in the operator evidence. The changed text must pass its privacy scan;
the full local tree scan reports the same 452 existing findings as its base
(including the worktree pointer and local denylist collisions). Full exact-head
CI purity remains required before merge.

The first full local gate passed lint and all 51 typecheck projects, then exposed
seven failing assertions: two migration-ledger expectations, two identity-reader
registry assertions and three existing recovery regressions. The remaining HTTP
lane was stopped after those failures were identified; that run is not a full
suite pass. Recovery now retains its original reservation binding and bounded
regular-file reader. The registry includes the cancellation validator without
exempting real environment reads, and the ledger expectations include migration
171. Eight targeted recovery tests and 37 consuming, registry and ledger tests
passed. Deliberately removing the request binding and inserting an environment
read each made its respective regression test fail; both mutations were restored.

Full local validation receipt will be recorded after the publication candidate
finishes the required shared-host gate.
