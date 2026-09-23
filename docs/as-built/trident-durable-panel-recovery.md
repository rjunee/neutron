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
the initial thread), and an atomic settled receipt. A pending attempt re-presents
its original hashed request through the runner's idempotent recovery path. Task,
credential, thread, model and policy are retained exactly; uncertain or invalid
outcomes remain blocked. Corrupt, foreign or missing evidence cannot purchase a
replacement attempt. The
single deferred retry remains consumed across reconstruction and needs its
original deferred receipt. Accounting/provider telemetry never supplies verdict
authority. Existing verdict validation, every panel veto and synthesis checkpoint
remain in the consuming gate.

The durable attempt ledger supplies only a refusal when an already-admitted
attempt loses its entire receipt directory or evidence root; it never restores a
verdict. Receipt reads use nonblocking nofollow opens, a bounded descriptor read,
and a second stat, rejecting FIFOs, excessive size and concurrent file growth.

Each operation pins one runner and task/credential scope. Scope is checked before
and after work; movement durably invalidates the pending receipt. Reverting the
credential cannot resurrect a completion produced under a different account.

Verification: 69 focused source/panel/receipt tests passed, including unchanged-input
reuse, required fresh work, retry exhaustion and successful recovery, account
rotation, concurrent claims, pending requests and corrupt/symlinked evidence.
Both root and Trident TypeScript checks passed. Nine semantic mutations failed
their targeted tests: rejecting valid settled recovery, assigning fresh retry
identities, omitting the measured head from identity, removing the durable
missing-directory refusal, permitting FIFO blocking, ignoring file growth,
refusing eligible pending recovery, ignoring the original request hash, and
ignoring credential movement. Lost-acknowledgement controls recover both review
and synthesis without another paid call, including headless thread continuation.
Restoring production code returned all 69 tests to green. The integration change wires current task
and credential identity and exercises `open/__tests__/project-build-e2e.test.ts`;
focused source evidence alone does not establish deployed efficiency.
