## 2026-10-05 — Wake native quota reconciliation when the CLI omits requestId

A bound native child emitted a complete synthetic assistant API error with
`error: rate_limit` and HTTP 429, but no `requestId` or `quotaLimits`. The local
observer required a request ID, so the acting turn kept waiting for a result
instead of reaching the existing signed capacity reconciliation.

`runtime/workers/claude-child-rate-limit.ts:5` now returns only a boolean wake-up
hint. It retains exact initial request, session, child, sidechain, stable bounded
read, synthetic assistant, API-error flag, rate-limit type and HTTP status checks.
Present quota enrichment must still say rejected. The unused event-payload
export and its digest are removed; no provider identifier is fabricated.
`runtime/workers/claude-capacity-client.ts:195` still requires authenticated
native all-full evidence and fresh capacity before waiting or continuation.
Original result precedence, signed deadlines, leases and episode claims remain
owned by their existing paths.

This supersedes only the historical local request-ID requirement in
`claude-child-rate-limit.md` and `claude-subscription-quota-envelope.md` in this
directory. The authored documentation search found those immutable records;
current normative specifications keep signed host observations authoritative.

Focused verification: the detector, acting-turn, capacity-client and native
continuation suites pass 238 tests with 864 assertions. The consuming
`open/__tests__/project-build-e2e.test.ts` selection passes 12 tests with 127
assertions, covering missing-ID waiting, same-child resumption, original-result
harvesting, repeated episodes, held acknowledgement, and refusal of unknown,
forged and foreign observations. Its additional arbitrary API-error case passes
with six assertions and retains the original child without observing capacity,
waiting or sending input.

Both semantic mutations were exercised through that consuming file: restoring
the request-ID requirement makes the missing-ID waiting case time out at its
30-second test bound; removing the typed rate-limit check makes the arbitrary
API-error case fail by assertion (blocked instead of unknown). Both were restored.
These isolated fixtures do not establish real account availability, deployment,
live original-child recovery or completion of issue #1416.

Final local receipt, on base `b962c70a5` with this change: the complete
`bun test open/__tests__/project-build-e2e.test.ts` exits 0 with 587 passed,
zero failed and 7,817 assertions. After restoring both mutations,
`bun test runtime/workers/claude-child-rate-limit.test.ts
runtime/workers/claude-capacity-client.test.ts
runtime/workers/claude-native-continuation.test.ts
runtime/workers/claude-acting-turn.test.ts` exits 0 with 238 passed, zero failed
and 864 assertions. `bunx --no-install tsc -p tsconfig.json --noEmit`,
`bunx --no-install tsc -p trident/tsconfig.json --noEmit` and
`bunx --no-install tsc -p open/tsconfig.json --noEmit` each exit 0.

The tested production blob is `4740f1d393b949da5857a9a5dd0b9417d9b4f1d6`;
the detector test blob is `3f503743aa888007ab4e833ae1d977a61c101eaf` and
the consuming test blob is `8366d355be63ede5e2cd2a1c1047007aad95d03e`.
The full repository suite and exact publication-head CI remain separate gates.
