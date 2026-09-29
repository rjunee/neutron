## 2026-09-29 — Durable Claude MCP handler admission and bounded drain evidence

The sink previously looked up a credential before awaiting JSON parsing, then
dispatched without a durable generation-bound admission. The bridge reused one
call ID for every invocation of the same tool. Revocation during the body read
could therefore leave an already-authenticated call able to enter a handler.

The bridge now supplies a unique invocation ID. The sink rechecks its live
credential binding after the body read and passes only host-derived parent,
project and admission-generation identity into the gateway ledger. Production
composition installs that ledger before native tool dispatch. Missing authority
refuses rather than falling back to unjournaled calls.

Migration 0165 adds generation and accepted-call records. Admission serializes
with the existing project fence, records acceptance before invoking a handler,
and refuses duplicate or conflicting invocation IDs. Handler return or throw is
recorded by outcome kind and digest; raw arguments, results and credentials are
not copied into this ledger. Crashes, failed writes, malformed records and
unserializable results remain unknown. Exact explicit closure prevents later
admissions. Ordinary local unregister does not close a durable generation, so a
surviving covered parent can be re-adopted. Adopted generations without historical
coverage remain unknown.

The proof is deliberately named `mcp-handlers-drained`, always accompanied by
`downstreamEffects: unknown`. A returned `work_board_start` may have delegated a
still-running build. This proof neither releases leases nor authorizes recovery,
termination, native replacement or credential rotation. Native shell/file tools
are outside this MCP boundary. Pending spawn credential activation and signed
placement/execute acknowledgment are separate prerequisites, not implemented
here. Existing running bridges using legacy `session:tool` IDs fail closed;
their supported reconnection remains a deployment prerequisite, not something
this change silently performs.

Verification: focused ledger tests cover positive execution, close refusal,
duplicates, conflicts, generation mismatch, adopted coverage, reopened pending
calls, failed persistence and malformed outcomes. Removing closure enforcement
fails the refusal test; forcing unconditional refusal fails its positive control.
Both mutations were restored. The named `project-build-e2e.test.ts` test exercises
the real sink and board dispatch, verifies delayed-body revocation, and proves
handler drain leaves the delegated build and native-child leases untouched.
Sink/graph tests and boot-adoption tests cover existing routing and restart
behavior. Local receipts: 72 tests pass across the ledger, bridge-response and
spec-index files; 56 sink/graph tests pass; 12 boot-adoption tests pass; the named
consuming E2E passes with 10 assertions. Each semantic mutant fails its targeted
test, then the restored ledger suite passes. Root and Trident TypeScript checks
are run before handoff; no live acceptance witness is inferred from these tests.

Independent review reproduced a dirty-read flaw in the first candidate: a
same-connection outcome update visible before COMMIT could certify drain and
then roll back. Proof is now asynchronous, takes the database mutex, and reads
one committed transaction snapshot; nested callers return unknown without
borrowing their uncommitted transaction. Real held settlement transactions
cover both rollback (unknown) and commit (drained). Bypassing the mutex fails
both concurrency controls; forcing unknown after a real commit fails the
positive control. The restored tests pass. The exhaustive migration-runner
inventory explicitly includes 0165 and its named first-apply test passes.

This is the safety foundation specified by
[`claude-tool-generation-settlement`](../spec-items/claude-tool-generation-settlement.md),
not completion of quota recovery or a served unattended-build acceptance witness.
