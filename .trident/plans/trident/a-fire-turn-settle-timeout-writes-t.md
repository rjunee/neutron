# IMPLEMENTATION_PLAN — a fire-turn settle timeout writes the run off as `failed` while the workflow it launched is still building (Plan card `fk…`)

Card: `buildSubstrateWorkflowFire` (trident/inner-loop.ts) resolves `{status:'failed', error:'fire turn did not settle within the budget'}` on launcher-settle timeout, and the orchestrator (`orchestrator.ts` `outcome.status !== 'fired'` branch) unconditionally terminalized the run — but "not settled" does NOT imply "not fired". Measured: 8 of 33 runs in 7 days; the wake then invites a second lane onto a branch a live lane holds (stopped only by wrong-base-guard luck), and twice the timeout wrote `failed` over a run whose own row said `outer-published:*` (built, pushed, CI green). Fix in four layers: (1) never write plain `failed` on settle-timeout without checking positive evidence the workflow started — the run's own `inner_checkpoint` first, filesystem probes second; (2) a distinct launched-but-launcher-unobserved outcome that holds the lane instead of terminalizing, expressed over EXISTING columns only (no new column, no new phase); (3) the terminal-build wake must not tell an agent to relaunch for this failure shape — resolve the branch holder first; (4) dispatch must refuse on branch LIVENESS (live worktree lock / non-terminal run on the branch), not only on branch shape.

## Resume state (round 18, 2026-09-02 — Argus r8 fix round: ONE blocker + one actionable major, both fixed with red-first controls)

Round 17's nomination satisfied the mutation gate; a fresh review of the SAME approved code
returned one blocker and one actionable major. Both are fixed on this branch (round-18 commit).

- **BLOCKER, fixed — `queueDecision` scoped its run lookup.** `deps.store.get(linkedRunId)` is
  keyed on the run id ALONE, so a stale/mis-copied `linked_run_id` naming another project's live
  run made `linkedLive` true here, sending `queueHold` down its `deleteByItem` arm and erasing
  the card's queued hold while promising a re-fire a foreign project's terminal event never
  delivers. Now compared against `deps.project_slug`, matching `run-progress.ts` and
  `work-wakeup-selection.ts`. Control: the cross-project boundary test in
  `board-dispatch.test.ts` (foreign live linked run + worktree lock on the branch → the refusal
  still QUEUES and carries its `hold`); removing the comparison reddens it, 39 pass / 1 fail.
- **MAJOR, fixed — the published marker is no longer substring-matched.** New
  `isPublishedUnreviewedReason` in `fire-evidence.ts` anchors on `PUBLISHED_REASON_HEAD`
  (offset zero) instead of `includes(MARKER)`; `delivery.ts` and `terminal-build-wake.ts` both
  call it. A launcher-crash reason embeds substrate output verbatim, so a failed build whose
  stderr quoted this file used to read as "built and published" and had its relaunch suppressed.
  Control: five negative tests (mid-string token, a whole authored reason quoted inside other
  text, the plain settle-timeout reason); reverting the predicate reddens all five, 104 / 5.
- **Minors/nits, fixed at the line each concerns:** the `store.ts` "always admits" docblock; the
  slug-arm collision now diagnosed as a slug collision, not a branch one; `refuseBranchLive` in
  the OUTER catch contained so a throwing hold write degrades to `backend_error`; the
  mtime-for-ctime substitution in `fresh_worktree` documented as a deliberate over-reporting
  widening; the `orchestrator.ts` r6 ceiling note corrected (`overCeiling` is computed in block
  (1b), BEFORE orphan recovery); the `run-disposition.ts` cross-reference recorded in
  `delivery.ts`; the stray blank line in `tick.ts`'s imports removed.
- **The mutation nomination is UNCHANGED and re-verified at this head.** No round-18 edit touched
  `classifyFireTimeoutRow`; the find-string `if (published !== null && Number(published[2]) === 0) {`
  still occurs EXACTLY ONCE in `trident/fire-evidence.ts`. Guard
  `bun test trident/fire-evidence.test.ts`, control `bun test trident/liveness.test.ts`.
- **Left as written down, deliberately:** the worktree-lock reason with no ` start <n>`, and
  `branch_live` holds paying full dispatch cost per drain. Both are trades already argued in-file;
  closing either means changing a bound, not fixing a defect.
- Standing, unchanged: never rebase; never merge main; the publisher owns origin; the Argus
  round-5 STALE-BASE findings stay dead (its 23k-line review diff was taken against a ten-day-old
  local main; that defect has its own card); the stray origin branch
  `trident/resume-note-round-5-already-built-a` (empty, at old origin/main) is remote-owner
  business. The salvage tag `trident-salvage/b5c5b38e-…` (`d56dc1d7`, +302/−688) stays UNADOPTED —
  adopting it would delete the `trident/store.test.ts` "ARGUS r7 (BLOCKER)" regression block.
- Known HOST-ENVIRONMENT suite failures OUTSIDE this branch's diff, identical at base `bee6dfd9`:
  `tests/integration/install-gbrain.test.ts`, `tests/integration/install-codex.test.ts`,
  `gateway/wiring/__tests__/build-gbrain-memory.test.ts`,
  `gbrain-memory/__tests__/resolve-gbrain-command.test.ts`,
  `tests/integration/github-credential-wired.open.test.ts` — a real gbrain/codex binary and an
  ambient token exist on this box, which is exactly what those tests assert absent; plus
  lane-composition flakes that pass on isolated re-run. Claiming `failed-preexisting` REQUIRES
  `suiteEvidence` carrying the base-branch comparison.

Rounds 1–17 (T1–T12 below) are recorded in this file's git history.

## Checklist (priority order)

- [x] **T1 — settle-timeout evidence gate at the orchestrator's fire-fail seam** (committed `91e85cd2`). Pure `trident/fire-evidence.ts` + tests; `inner-loop.ts` literals → shared constant; orchestrator's optional `gather_fire_evidence` seam consulted only on the settle-timeout error; red-first controls passed; unwired seam byte-identical.
- [x] **T2 — production evidence gatherer** (committed `afb97906`). `trident/fire-evidence-probes.ts` (fresh-row re-read first, then the branch-holding linked worktree; live-lock pid with recycled-pid starttime check; positive-only; basenames + pids only) + exported `parseWorktreeList`/`probeBranchHolder`/`parseProcStartTime`, full unit suite.
- [x] **T3 — wire the gatherer at the composition root** (committed `76a85ebb`). `build-core-modules.ts` passes `gather_fire_evidence` beside `gather_run_evidence`; composed wiring test proves A (live lock → lane held), B (`outer-published:*` row → published/review-not-run), C (no evidence → byte-identical `failed`); A and B recorded red first.
- [x] **T4 — dispatch refuses on branch liveness (card req 4)** (committed `4483cd46`). `branch_live` gate in `trident/board-dispatch.ts` (after `already_landed`, and it queues); `defaultBranchHolderProbe` exported from fire-evidence-probes; `work-board-surface.ts` union widened; full red-first refusal suite in `board-dispatch.test.ts`.
- [x] **T5 — the wake stops inviting a relaunch for this failure shape (card req 3)** (round 6). `buildTerminalBuildWakePrompt`: for the settle-timeout and published failure reasons, instruction 2 becomes resolve-the-branch-holder-first guidance; every other reason byte-identical, pinned verbatim. (Round 11: the prompt no longer promises a `work_board_start` resume that does not exist.)
- [x] **T6 — record it** (round 6). `.trident/as-built/trident/a-fire-turn-settle-timeout-writes-t.md` entry (`docs/AS_BUILT.md` untouched, per the one-writer rule); plan + `.trident/plans` card doc truth-synced. Extended every subsequent round.
- [x] **T8 — Argus round-5 findings** (rounds 10–11, `4b31f660` + `90e9a7d3`). Multi-entry branch-holder probe; drain floor; honest `branch_live` queue prose; hard-asserted refusal code; trimmed checkpoint at the write site with raw CAS token; duplicate plan doc removed.
- [x] **T7 — land the salvaged typecheck fix** (round 9). `git merge --ff-only 726b92b2` (tag `trident-salvage/d567f33a-…`, parent `3f14fcd0`); no hand edits; CI `typecheck` SUCCESS on PR #498 since.
- [x] **T10 — PR-cycle Argus r3/r4 findings** (rounds 12–13, `05faca77` + `cb913e03`). Single `queued` decision + `queueHold` across all three gates; marker token; source-scoped drain-wire pin; throw-proof lane-holding save.
- [x] **T9 — verification-only settle round** (round 14, `fcd2f8e8`). Zero source changes; tip re-proven green locally; docs truth-synced so a valid review could run on the branch's real diff.
- [x] **T12 — Argus r6/r7: the queue/no-queue decision and the branch race land at the write** (rounds 15–16, `43c648d9` + `d97e4bce`). `createIfClaimsAvailable` re-takes branch liveness inside the insert's transaction, reports `conflict: 'branch'` through the shared `refuseBranchLive`; drain wire proved by calling it; null-probe TOCTOU arm covered.
- [x] **T13 — Argus r8 fix round** (round 18). Cross-project scope check in `queueDecision` + boundary test; `isPublishedUnreviewedReason` anchored on the producer's head, wired at both consumers, with five negative controls; six minors/nits fixed at the lines they concern; nomination re-verified unchanged.
- [x] **T11 — terminal nomination round: ZERO source changes; nominate the proven mutation.** Re-verify the find-string occurs exactly once in `trident/fire-evidence.ts` at HEAD; locally re-prove red-then-green in the worktree (apply `if (false) {` via the exact-substring replace, guard exits non-zero, control exits zero, restore, guard exits zero, porcelain clean); commit ONLY the truth-synced docs (this file + the byte-identical `.trident/plans/trident/a-fire-turn-settle-timeout-writes-t.md` copy + a dated round entry appended to `.trident/as-built/trident/a-fire-turn-settle-timeout-writes-t.md`; `docs/AS_BUILT.md` untouched); meet the terminal-task test obligations honestly (full suite — if only the known host-env failures appear, `suiteOutcome` `failed-preexisting` with EARNED `suiteEvidence`; `scripts/ci/typecheck-all.sh` with `trident/tsconfig.json` PASS; `scripts/ci/lint.sh`); and report `mutationClaim` in the forge structured output: file `trident/fire-evidence.ts`, find = the exactly-once outer-published guard line, replace `if (false) {`, guard `["bun","test","trident/fire-evidence.test.ts"]`, control `["bun","test","trident/liveness.test.ts"]`. A fix round that moves the target line MUST re-verify uniqueness and re-nominate with the corrected find; a fix round that does not touch it should nominate nothing (the build round's nomination stands automatically).
