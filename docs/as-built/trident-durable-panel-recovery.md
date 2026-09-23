## 2026-09-23 — Retain panel observations and retry consumption across host replacement

Issue #1196; specification: `docs/spec-items/trident-build-efficiency.md:154`
and `docs/spec-items/trident-build-efficiency.md:190`.

Reconstructing a review source previously discarded its private observation maps
and retry set. A measured one-seat panel purchased another review and synthesis
for the same task, head, brief and round. A deferred seat also regained its spent
retry. Repeating the same operations on the original source purchased no work,
which isolated reconstruction as the cause.

The source now writes host-owned receipts keyed by the canonical task bytes,
task identity, measured snapshot, round, seat/model/effort, selected credential
digest, environment, execution policy and exact brief. Synthesis additionally
binds the complete supplied panel. Completed observations recover before thread
handling; changed inputs obtain fresh observations. Selected credential rotation
also changes the thread ownership key. Missing task or credential identity permits
only source-local reuse and cannot claim durable recovery.

Each attempt has an exclusive directory claim, its original request (including
the initial thread), and an atomic settled receipt. Pending, corrupt, foreign or
missing evidence refuses reuse and cannot purchase a replacement attempt. The
single deferred retry remains consumed across reconstruction and needs its
original deferred receipt. Accounting/provider telemetry never supplies verdict
authority. Existing verdict validation, every panel veto and synthesis checkpoint
remain in the consuming gate.

Verification: 61 focused source/panel tests passed, including unchanged-input
reuse, required fresh work, retry exhaustion and successful recovery, account
rotation, concurrent claims, pending requests and corrupt/symlinked evidence.
Both root and Trident TypeScript checks passed. Three semantic mutations failed
their targeted tests: rejecting valid settled recovery, assigning fresh retry
identities, and omitting the measured head from identity. Restoring production
code returned all 61 tests to green. The integration change wires current task
and credential identity and exercises `open/__tests__/project-build-e2e.test.ts`;
focused source evidence alone does not establish deployed efficiency.
