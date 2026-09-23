## 2026-09-23 — Start independent panel seats together and drain every result

This is the panel-core slice of #1196, implementing the scheduling requirement in
`docs/spec-items/trident-build-efficiency.md:117-138`. Previously,
`trident/gates/review-panel.ts` awaited each seat before starting the next one.
Seat reads can dispatch paid work, so independent reviews were serialized.

The panel now starts all enabled seat reads together and uses an `allSettled`
barrier before inspecting them. Rejected calls cannot finish the panel while a
sibling is still running. Results are inspected in configuration order, retaining
deterministic refusal selection and finding order even when completion order is
reversed. Synthesis remains after the barrier and all observation validation.
Existing admission, provenance, required-seat, bounded-retry, reserved-marker,
escalation and independent-veto rules remain in their existing owners (G057–G062).

Deterministic tests hold both seats behind explicit promises, verify both started
before release, release them in reverse order, and verify synthesis waits. Paired
controls retain valid approval and disabled-seat exclusion. Rejection tests keep
one sibling pending and prove the decision waits; a faster later-seat failure
cannot override an earlier-seat provenance refusal. Invalid admission dispatches
no work. The project review-source schema test now checks the complete seat set
and synthesis-last ordering without requiring serial reviewer dispatch.

Semantic mutation experiments restored serial awaits (two tests failed), replaced
the barrier with fail-fast `Promise.all` (one failed), started synthesis before
the barrier (two failed), and admitted disabled seats (three failed). Each failure
was an observable scheduling or decision assertion, not a parsing failure. The
restored panel and source suites pass all 46 tests; both root and Trident
TypeScript checks pass. Together with the full consuming
`open/__tests__/project-build-e2e.test.ts`, all 171 tests pass (1,616 assertions).
The initial sandboxed attempt could not bind the fixtures' Unix sockets; the
complete rerun with local socket access passed. As-built, governed-repository
and stale-prose guards pass.

The local denylist scan is not globally green: exported base `219262bf7` and
this implementation both report the same 455 inherited findings (167 substring
and 288 word findings). Scanning the changed files with the repository license
reports zero findings, as do the commit and PR-message scans. No allowlist or
leak rule was changed.

This slice alone does not establish concurrent execution in the real REPL
consumer, overlap with the standalone review, or deployed latency/token savings.
Those remain required by #1196, including the consuming barrier in
`open/__tests__/project-build-e2e.test.ts` and fresh live dispatch evidence.
