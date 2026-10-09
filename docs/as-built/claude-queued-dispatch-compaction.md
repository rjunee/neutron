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
131 acting-turn tests passed after review strengthened the historical control.
New controls cover cancellation, original expiry,
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
original source bytes were restored after each experiment set. Cross-model review
found that the initial historical fixture used a synthetic dispatch rather than
the runner's actual prompt. The corrected fixture seeds the actual command before
boundary capture and asserts it equals the submitted bytes. A fourth mutation,
reading from byte zero, now makes that historical case incorrectly complete and
is rejected. Foreign-session absorption and attachment controls were also added.

Native and bounded cross-model source reviews returned GO. The first shared-host
validation passed lint, then found a missing test callback parameter type in the
Open check. That attempt was stopped before the full suite while applying the
review correction. The corrected Open package typecheck passed. These partial
results are not a full local validation receipt.

The combined candidate's full local check later exposed an incorrect exact-time
assertion in this new matrix: the actor received less than the nominal wall
budget after runner preparation, but the fixture expected the nominal deadline.
The fixture also mixed the runner's real-clock queue budget with the actor's
logical clock. The correction asserts expiry at the actual offered allowance and
uses the actor's logical-clock budget, following the existing dispatch-evidence
fixture. Two additional cases impose a synthetic 17 ms preparation debit; both
failed before the correction while foreign/absent-session controls passed.
Afterward the entire acting-turn file passed: 133 tests, zero failures and 72,676
assertions. The runtime typecheck and lint passed; independent source review returned
GO. Production deadlines, cancellation, identity refusals, submission counts and
child-only slot transfer are unchanged. These affected checks do not establish a
final-head local full-suite pass.

The local archive purity scan reported 451 findings on the candidate and its
unchanged base, with identical reported findings and totals. The scanner truncates
individual findings, so this comparison does not establish equality of every
undisplayed finding or a full-tree pass. The commit-message and issue-prose gate
passed. Exact-head CI remains required.

The existing orchestrator spec records this scoped acceptance. Full local gates,
independent review, exact-head CI, deployed-source verification and fresh live
acceptance remain delivery checks; no production run, lease, receipt or candidate
branch was edited by this repair.
