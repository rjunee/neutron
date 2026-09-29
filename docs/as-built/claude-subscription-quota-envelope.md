## 2026-09-29 — Recognize bound subscription quota errors without quotaLimits enrichment

The native Claude quota observer required `quotaLimits.status: rejected`, but
the measured subscription error omitted `quotaLimits` while retaining the
synthetic assistant marker, typed API error, `rate_limit`, HTTP 429 and request
ID. The original acting turn consequently waited for a result the child had
not written. `runtime/workers/claude-child-rate-limit.ts:32` now permits that
field to be absent; present enrichment must still say `rejected`. Full initial
request equality, parent session, child identity, sidechain, synthetic model,
API-error flag, rate-limit type, HTTP status and request ID remain required.
This supersedes the mandatory quota enrichment described in the immutable
`docs/as-built/claude-child-rate-limit.md` record; the authored search found no
other current specification asserting that requirement.

The actor rechecks the result file after provider observation
(`runtime/workers/claude-acting-turn.ts:335`). An available current result keeps
its ordinary decoder precedence; malformed current results remain unknown,
while stale and foreign results cannot replace the typed provider block.
No transcript error becomes a verdict or releases child admission. The
existing cumulative usage observer and step reservation remain intact.

Focused proof covers missing enrichment, contradictory enrichment, foreign
envelopes and requests, quoted errors, ordinary assistant stops, partial writes,
valid/malformed/stale/foreign result races through the consuming runner,
concurrent sibling success, retained usage, and recovery without redispatch.
The named `open/__tests__/project-build-e2e.test.ts` case, "a typed subscription
quota-limited synthesis stops without quotaLimits enrichment, trailer, replay,
fix or merge", passes and checks the original child lease is retained.
Bidirectional semantic mutations failed by assertion: restoring mandatory
quota enrichment lost the positive control; removing the typed error check
accepted an unrelated authentication error. Result-precedence mutations also
failed by assertion: removing the result reread changed a concurrently written
valid result from completed to blocked; unconditionally ending the turn changed
the missing-result, stale-result and foreign-result quota controls from blocked
to unknown. All four mutations were restored, and the seven affected quota and
race cases passed again.
`bun test runtime/workers/claude-child-rate-limit.test.ts
runtime/workers/claude-acting-turn.test.ts` passes 127 tests; the named consuming
case passes with seven assertions. Root, Open and Trident `tsc --noEmit`
checks pass after incorporating the independent fixture type correction.

The repair applies to original acting-turn observation. Replacement-host
recovery still reads the reserved result and usage only
(`runtime/workers/claude-in-repl.ts:45`, `:86`;
`runtime/workers/project-runners.ts:166`); no live pending child was replayed,
restarted or settled by this change. Final-acknowledgement usage collection
also remains separate unfinished work. Full-suite and complete typecheck
matrix proof belong to the integrated publication head.
