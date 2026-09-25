## 2026-09-25 — Native child ownership survives uncertain run termination

The locked project workspace contract preserves unknown liveness. Run failure
and parent-turn completion had incorrectly released native-child leases, including
when the result file contained only `{}`. The existing admission store now keeps
child ownership by the JSON tuple of run and step. Terminal run observation and
boot reconciliation release build leases only. The consuming project runner
releases a child only after validating its request-specific terminal trailer;
recovery follows the same path. A terminal outcome from the underlying reservation
consumer is required before reading terminal evidence: changed requests or result
paths returning unknown cannot release the original child's lease. Pre-dispatch
refusal can release its own token.

Open supplies runtime retirement, warm refresh and model control with a query
against that same admission authority. Queries preserve exact conversation project
identity, including General versus a named `general` project. No second journal
or lease timeout is introduced. Legacy run-only child leases remain unresolved.

Focused admission, restart, acting-turn and model-control tests pass, as do the
consuming build tests for malformed and valid results. Semantic mutations restoring
early release, omitting valid completion release, and bypassing the durable query
each fail their targeted tests. Root and Open TypeScript checks pass.

Integrated with the exact-generation replacement path: two unresolved children
survive run failure and restart; replacement stays busy after the first child's
completion and succeeds only after both children complete. Both run and recovery
reject a changed request or path despite a same-step terminal envelope there;
unchanged requests can consume that evidence. Removing the reservation-outcome
guard fails both changed-request tests.

This does not implement the separate queue-budget work in #1295. A legacy child
without request-specific terminal evidence remains retained; neither a failed
run nor an idle parent is an operator cleanup authorization. Live provider and
deployed restart behavior still require external proof.
