## 2026-10-08 — Keep planner grants valid while sibling workspace proofs complete

Two fresh native-child admissions could fail a planner before any child dispatch.
The durable lease precedes asynchronous Git workspace measurement, so one planner
could see its sibling's lease before the measured local workspace record existed.
Planner binding checked that incomplete census immediately; the acting-turn wait
ran later and could not help. The same check also affected operations from an
already-bound planner when a new sibling began preparation.

Planner authorization now waits for the complete census at initial binding and
each subsequent operation. The wait retains the existing deadline and cancellation
signal, refuses lost ownership or a departed parent, and cannot turn an unknown
owner into a measured one. The worker awaits authorization and checks expiry and
cancellation again before continuing. Existing workspace identity, serialized
operation, write and publication checks remain in place. There is no new budget,
lease release mechanism, replay path or alternate planner implementation.

The acceptance contract is in `docs/spec-items/trident-build-efficiency.md`.
Focused validation under the ordinary service UID passed 24 planner/workspace
tests with 153 assertions and 18 consuming project tests with 173 assertions.
The consuming run included eleven new planner cases and seven existing workspace,
original-budget and lost-acknowledgement controls. It used the authenticated
process-isolation preload, real SQLite admission and independent linked Git
worktrees. An unknown dispatched fixture child was settled through original-request
recovery of its validated late result, without resetting slots or deleting leases.
The Open TypeScript project and whitespace checks passed.

Worker semantic mutations demonstrate that ignoring an asynchronous refusal
permits an unauthorized write, unconditional refusal loses legitimate planning,
and removing the post-await expiry check admits a stale operation. Two composition
mutations were also killed by their consuming assertions: restoring synchronous
census authorization rejected a legitimate waiting operation, while bypassing the
planner census allowed a write beside a real foreign admission. Both mutations
were restored with identical source/test hashes; neither failure depended on a
syntax error, timeout or failed cleanup.

The canonical `bash scripts/check-shared-host.sh` passed on
`a95ce7a21136013b8772c4926f5fea6142c92c5e` under the ordinary service UID:
lint, all 51 TypeScript projects, and all 1,795 discovered test files across 19
bounded-memory lanes. All lanes were green, and the entry point verified unchanged
suite inputs throughout the 2,185-second run. The complete consuming
`open/__tests__/project-build-e2e.test.ts` passed all 598 cases, including the eleven
new planner cases. Independent native and Claude reviews of this revision found
no merge blockers. The publication revision adds only this validation record.

The local full-tree privacy scan was not a passing receipt: unchanged main
reported the same 451 denylist findings, while the linked checkout added one
untracked Git-metadata finding. No scanner, denylist or allowlist was changed.
Commit/PR message preflight and exact-publication-head CI purity remain required.

Live unattended single-card, task-sequence and concurrent-card acceptance remains
separate and unverified by this source change.
