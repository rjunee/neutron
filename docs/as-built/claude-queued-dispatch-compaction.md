## 2026-10-09 — Observe queued native dispatches during compaction

Issue #1180 exposed a second transcript shape at the launch probe. Claude can
record terminal input as `queue-operation/enqueue` while compacting, then remove
the entry with reason `absorbed_mid_turn` and represent the consumed command as a
`queued_command` attachment. The observer recognized only `user` messages, so it
could report unknown before the matching native child appeared. The preceding
task had completed and the host had automatically advanced to the next task;
that progress did not establish a completed sequence.

`runtime/workers/claude-acting-turn.ts` reads these additional shapes at the
existing launch probe. Queue evidence requires the exact current session and
complete dispatch, allowing only the already supported whole `pasted_content`
envelope. A matching removal without observed absorption clears queued evidence.
Historical records remain outside the pre-submission byte boundary; file identity,
truncation and bounded-read checks remain in force.

Queue evidence permits observation of the same submission under its original wall
deadline. It does not bind a native child, transfer the parent input slot, prove
completion, replay work or buy another budget. The existing exact-child binding
and trailer validation retain those responsibilities. No timeout constant changes.

The acting-turn regression first failed on the eight cases requiring continued
observation, while all ten refusal controls passed. After the correction, all
129 acting-turn tests passed. New controls cover cancellation, original expiry,
foreign and absent session identity, historical commands, payload/envelope
mutations, notifications, removals, queued attachments, and a later bound child
that alone permits slot transfer.

The consuming `open/__tests__/project-build-e2e.test.ts` cases exercise real host
composition, native admission, result decoding, temporary Git publication and
merge with synthetic model/GitHub boundaries and an injected actor observation
clock. Exact queued evidence reaches merge; foreign-session and notification
decoys stop unknown and retain the native lease. All three cases passed. Three
separate source mutations were rejected by those consuming tests: ignoring queued
evidence, accepting foreign sessions, and accepting an embedded dispatch. The
original source bytes were restored after each experiment set.

The existing orchestrator spec records this scoped acceptance. Full local gates,
independent review, exact-head CI, deployed-source verification and fresh live
acceptance remain delivery checks; no production run, lease, receipt or candidate
branch was edited by this repair.
