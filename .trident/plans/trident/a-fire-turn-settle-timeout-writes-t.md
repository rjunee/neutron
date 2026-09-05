# IMPLEMENTATION_PLAN — a fire-turn settle timeout writes the run off as `failed` while the workflow it launched is still building (Plan card `fk…`)

Card: `buildSubstrateWorkflowFire` (trident/inner-loop.ts) resolves `{status:'failed', error:'fire turn did not settle within the budget'}` on launcher-settle timeout, and the orchestrator (`orchestrator.ts` `outcome.status !== 'fired'` branch) unconditionally terminalized the run — but "not settled" does NOT imply "not fired". Measured: 8 of 33 runs in 7 days; the wake then invites a second lane onto a branch a live lane holds (stopped only by wrong-base-guard luck), and twice the timeout wrote `failed` over a run whose own row said `outer-published:*` (built, pushed, CI green). Fix in four layers: (1) never write plain `failed` on settle-timeout without checking positive evidence the workflow started — the run's own `inner_checkpoint` first, filesystem probes second; (2) a distinct launched-but-launcher-unobserved outcome that holds the lane instead of terminalizing, expressed over EXISTING columns only (no new column, no new phase); (3) the terminal-build wake must not tell an agent to relaunch for this failure shape — resolve the branch holder first; (4) dispatch must refuse on branch LIVENESS (live worktree lock / non-terminal run on the branch), not only on branch shape.

## Resume state (round 21, 2026-09-02 — Argus r10 fix round: two blockers, both fixed with red-first controls)

Rounds 19–20 closed the r9 hold-write containment and the r10 `attempted: 'upsert' | 'delete'`
reporting split. Round 21 (this one) answers Argus r10's second review: two BLOCKERS, one of them
documentation.

- **BLOCKER, fixed — the cross-process branch race also arrives as `SQLITE_BUSY`.** The outer
  catch in `board-dispatch.ts` classified the two-connection race by its ERROR TEXT and mapped
  only `UNIQUE constraint failed: code_trident_runs.(project_slug|slug)` to the `branch_live`
  refusal + hold. Codex's two-`ProjectDb` repro shows the same fact surfacing as
  `BusyRetryExhaustedError: SQLITE_BUSY: exhausted 15 retries`, which that regex does not match —
  so the loser returned `backend_error` (HTTP 500) and queued NOTHING: the card on the floor. The
  classifier is now the STORE, not the string: on ANY failed insert the catch re-reads the live
  holder (this repo's branch, or this project's slug — the index's other arm) and, when one is
  visible, returns the same refusal, the same hold, and names the winner. Positive evidence only:
  no visible holder is still `backend_error`. The re-read is skipped once the insert has WON, so a
  post-create failure (`board.attachRun`, `holds.deleteByItem`) can never park a card behind its
  own run. Controls in `board-dispatch.test.ts`: a real second `ProjectDb` on the same file lands
  the competitor's row while this dispatch's write fails BUSY → `branch_live` + a real hold row
  (red first: 46/1); the no-holder sibling stays `backend_error` and queues nothing; the
  post-create throw stays `backend_error` with the run intact.
- **BLOCKER, fixed (doc-only) — this resume state was stale at round 18.** It still nominated the
  round-18 mutation target (`trident/fire-evidence.ts`) that the as-built superseded in round 20,
  so a prover following the plan would run the wrong guard/control contract. The nomination below
  is the round-20 one, re-verified at this head.
- **Minor, fixed — the published round is bounded AT THE WRITER.** `OUTER_PUBLISHED_CHECKPOINT`
  accepts `\d{1,9}`; the orchestrator interpolated `result.round` (substrate JSON, unbounded)
  verbatim, so an absurd round wrote a marker the settle-timeout gate reads as NOT published —
  terminalizing a run that had just pushed. New `checkpointRoundField` clamps it; the write site
  calls it; boundary tests pin the clamp and that every clamped marker still parses as published.
- **Minor, fixed — `queueDecision`'s two READS are contained**, the same escape class the r9 fix
  closed for the hold WRITE. A throwing `board.get` falls back to the opening snapshot; a
  throwing `store.get` counts the linked run as LIVE, which takes `queueHold`'s delete arm and can
  therefore never CREATE a hold behind a card that may already have an owner. Control: a throwing
  `store.get` still returns the typed `branch_live` refusal, queues nothing, and clears a stale
  row (red first: 46/1).
- **Nits, fixed at the line each concerns:** `probeBranchHolder`'s `probe_pid_alive` call is
  wrapped, so the "returns null when we could not look" / "neither step may throw" docblocks are
  true for an injected seam (a throw reads as `unknown` = no evidence); `saveIfActive`'s `round`
  bind now honours the SAME compare-and-swap as the checkpoint it is derived from (a lost CAS
  contributes 0), with a red-first control and its must-pass sibling.
- **Not done, deliberately, and unchanged from rounds 19–20.** (a) The one-shot gather at the
  timeout instant: the row is classified once, at t+0, while the card's own measurements put first
  evidence 63–86 s later. Both reviewers who raised it recommended deferral, the downstream harms
  are closed (terminal-build-wake keys on the reason string; the dispatch gate refuses on liveness
  once the worktree exists), and closing it means holding the row open across ticks while the
  negative control `6948da2d` must still terminalize — a change to the step state machine, not a
  wrap. It stays a tracked follow-up. (b) The composed tick/drain test's call-count assertion: the
  in-file docblock argues the deliberate split and both approving reviewers accepted it —
  `open/__tests__/open-dispatch-hold-drain-wiring.test.ts` proves the PRODUCTION-composed drain
  moves real hold state, and joining the halves would mean building the sweep inside the
  composition test, which proves nothing about production.
- **The mutation nomination is the ROUND-20 one, re-verified at this head.** File
  `trident/board-dispatch.ts`; find `if (outcome.attempted === 'delete') {` (occurs EXACTLY ONCE
  at this head — round 21 did not touch `queueFailureClause`); replace `if (false) {`; guard
  `bun test trident/board-dispatch.test.ts`; control `bun test trident/liveness.test.ts`.
- Standing, unchanged: never rebase; never merge main; the publisher owns origin; the Argus
  round-5 STALE-BASE findings stay dead (its 23k-line review diff was taken against a ten-day-old
  local main; that defect has its own card); the stray origin branch
  `trident/resume-note-round-5-already-built-a` (empty, at old origin/main) is remote-owner
  business. The salvage tag `trident-salvage/b5c5b38e-…` (`d56dc1d7`, +302/−688) stays UNADOPTED —
  adopting it would delete the `trident/store.test.ts` "ARGUS r7 (BLOCKER)" regression block.
- **A build in this worktree must `bun install` FIRST.** A fresh linked worktree has no
  `node_modules`, so `@neutronai/*` resolves up to the SHARED checkout — whose `trident/store.ts`
  and migrations belong to a different lineage, and the suite then fails with `no such column:
  claimed_paths` / `no such table: code_trident_dispatch_holds` at BASE as well as at head. That is
  a workspace-setup artifact, not a defect: 47/47 in `board-dispatch.test.ts` after `bun install`.
- Known HOST-ENVIRONMENT suite failures OUTSIDE this branch's diff, identical at base `bee6dfd9`:
  `tests/integration/install-gbrain.test.ts`, `tests/integration/install-codex.test.ts`,
  `gateway/wiring/__tests__/build-gbrain-memory.test.ts`,
  `gbrain-memory/__tests__/resolve-gbrain-command.test.ts`,
  `tests/integration/github-credential-wired.open.test.ts` — a real gbrain/codex binary and an
  ambient token exist on this box, which is exactly what those tests assert absent; plus
  lane-composition flakes that pass on isolated re-run. Claiming `failed-preexisting` REQUIRES
  `suiteEvidence` carrying the base-branch comparison AND the failing file NAMES.

Rounds 1–20 (T1–T13 below) are recorded in this file's git history and in
`.trident/as-built/trident/a-fire-turn-settle-timeout-writes-t.md`.

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
- [x] **T14 — Argus r10 fix round** (round 21). The insert-race is classified by the STORE, not by the error text, so a `SQLITE_BUSY` loser gets the `branch_live` refusal + hold instead of a 500 that queues nothing (two-`ProjectDb` boundary control, plus the no-holder and post-create-throw siblings); this resume state is brought forward to the round-20 mutation nomination; `checkpointRoundField` bounds the published round at the writer; `queueDecision`'s two reads are contained; two nits fixed at their own lines with red-first controls.
- [x] **T11 — terminal nomination round: ZERO source changes; nominate the proven mutation.** Re-verify the find-string occurs exactly once in `trident/fire-evidence.ts` at HEAD; locally re-prove red-then-green in the worktree (apply `if (false) {` via the exact-substring replace, guard exits non-zero, control exits zero, restore, guard exits zero, porcelain clean); commit ONLY the truth-synced docs (this file + the byte-identical `.trident/plans/trident/a-fire-turn-settle-timeout-writes-t.md` copy + a dated round entry appended to `.trident/as-built/trident/a-fire-turn-settle-timeout-writes-t.md`; `docs/AS_BUILT.md` untouched); meet the terminal-task test obligations honestly (full suite — if only the known host-env failures appear, `suiteOutcome` `failed-preexisting` with EARNED `suiteEvidence`; `scripts/ci/typecheck-all.sh` with `trident/tsconfig.json` PASS; `scripts/ci/lint.sh`); and report `mutationClaim` in the forge structured output: file `trident/fire-evidence.ts`, find = the exactly-once outer-published guard line, replace `if (false) {`, guard `["bun","test","trident/fire-evidence.test.ts"]`, control `["bun","test","trident/liveness.test.ts"]`. A fix round that moves the target line MUST re-verify uniqueness and re-nominate with the corrected find; a fix round that does not touch it should nominate nothing (the build round's nomination stands automatically).
