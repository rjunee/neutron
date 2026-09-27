## 2026-09-27 — Consuming cancellation regression proves sibling survival

Issue #1265 requires a simultaneously running unrelated fixture to survive the
served cancellation route (`docs/spec-items/cancel-stops-host-review-suite.md:64`).
The existing consuming regression now starts a production host suite for a
second fixture's exact durable run row, alongside the target's real build host
(`open/__tests__/project-build-e2e.test.ts:1540`, `:1587`). Each suite has its own
process owner, working directory, abort signal, and finite fixture deadline.

Heartbeat counters are published by atomic rename (`:1563`). After
`codegen_cancel` stops the target and its host settles, both the sibling parent
and its detached TERM-resistant child must acknowledge a newly issued probe by
publishing a later heartbeat (`:1607`). The target counters must remain unchanged
over that causal interval, including a 100 ms observation floor (`:1611`).
Review found that an immediate sibling acknowledgement could arrive before a
surviving target descendant's next 20 ms tick; retaining the original floor
prevents that scheduling window from weakening the stopped-process assertion.
Existing assertions retain the stopped row, native
child leases, and absence of review, fix, merge, and usable suite receipts
(`:1621`). Cleanup aborts each suite through its own signal, writes each fixture's
release fallback, and awaits both owners (`:1629`).

Validation: the exact consuming test passed before and after the controls.
Removing durable cancellation observation from `runHostSuite` failed the bounded
target-settlement check. Changing finished-claim selection from equality to any
claim-bearing process failed the sibling's post-cancel acknowledgement check.
Both mutants parsed and executed the fixture, and both owners reported confirmed
cleanup before the failing test returned. Production files were restored byte for
byte. The relevant host-suite file passed all 26 tests; root and Trident
TypeScript checks passed. Workspace dependency preflight passed with its existing
optional SDK-resolution notes.

A further exact-claim mutant skipped signalling the fixture's detached child
while still stopping its parent. In a verified private PID/proc namespace, the
sibling's acknowledgement control completed, then the target heartbeat equality
assertion failed (`:1621`): the child counter advanced from 60 to 65 while its
parent remained at 56. The release fallback and awaited owners completed before
the test returned. Restoring descendant signalling passed the same focused test;
both TypeScript checks passed again after the observation-floor correction.

This shard records the bounded consuming-test slice. Frozen integration revision
`57dae6c04922cb5a6eaa469e449b22f5451b3691` subsequently passed
`bash scripts/check-shared-host.sh` with exit zero: 51 TypeScript configurations
and all 1,731 test files across 18 lanes, with zero failed lanes. The complete log
SHA-256 is `030f031cccf2d99f8b6035a983a7794ecf7cad7898ce9a0b0369ec5aa716a1e8`.
This tested revision differs from the later publication head recording its
receipt. Exact-head CI and fresh served cancellation evidence remain required
before issue closure; no runtime receipt is transferred by this record.
