## 2026-10-03 — Make the acknowledgement budget fixture deterministic

The acting-turn budget test raced a 45 ms timer against filesystem observation.
When observation crossed the deadline before timer delivery, the consumer
correctly returned UNKNOWN with the more specific missing-worker diagnostic
(`runtime/workers/claude-acting-turn.ts:375-396`). When the timer won, it returned
the generic missing-trailer diagnostic (`runtime/workers/claude-acting-turn.ts:409-429`).
The test required only the latter text despite supplying neither worker evidence
nor a trailer. CI selected the former branch. A delayed directory-observation
fixture reproduced the same failure on the original test.

The corrected test supplies an isolated projects directory and holds the existing
injected observation clock at an awaited barrier. It requires one submitted line,
an unsettled outcome and a held turn slot before advancing the virtual host
budget to expiry; afterward it requires the exact missing-trailer UNKNOWN result
and one released slot (`runtime/workers/claude-acting-turn.test.ts:352-403`). The
90-second budget is virtual and expires by an explicit clock advance, without
waiting 90 seconds. This retains the rule that terminal acknowledgement proves
parent input only (`docs/spec-items/claude-same-agent-continuation.md:81-84`).

The fixture owns an abort controller and a two-second failure bound for reaching
the observation barrier, cleared during cleanup. Its unconditional cleanup
advances virtual time, aborts, releases the barrier and awaits the outcome even
when an assertion fails. A forced pre-expiry assertion control requires the turn
slot to be released before returning and checks that subsequent filesystem turns
produce only the explicitly requested result probes
(`runtime/workers/claude-acting-turn.test.ts:389-429`).
An injected stalled barrier also fails within the two-second bound and reports
the owned turn released during the unconditional cleanup.

The adverse-observation fixture fails the original test and passes the correction.
A deliberate premature UNKNOWN outcome fails the corrected test immediately.
The completion-after-trailer, stale-trailer, unreadable-trailer and cancellation
controls passed with the delayed observation fixture. The final acknowledgement
and failure-cleanup controls also pass with that delay: two tests, 22 assertions.
The complete affected file passed after the cleanup correction: 111 tests, zero
failures and 500 assertions with Bun 1.3.13. After correcting the overloaded
probe spy's TypeScript signature, the six affected accepting, refusing and cleanup
controls pass with 33 assertions; Root and Trident typechecks pass. The repository suite is not
rerun or claimed by this correction. Production guards and the consuming
`open/__tests__/project-build-e2e.test.ts` source remain unchanged.
