---
type: plan
title: "A fire-turn settle timeout writes the run off as `failed` while the workflow it launched is still building — 8 of 33 runs in 7 days, and the wake then invites a second lane onto the same branch"
created: 2026-09-01T07:56:16.304Z
---

# A fire-turn settle timeout writes the run off as `failed` while the workflow it launched is still building — 8 of 33 runs in 7 days, and the wake then invites a second lane onto the same branch

# A fire-turn settle timeout marks a run `failed` while its inner workflow is alive and building

## The symptom, observed end to end on 2026-09-01

Run `9663fed7-2231-4a75-88d6-7d5f63966c5f` (card `01M1DMBZ0WCWY35W06GE7N75SW`, PR #497):

    started_at        2026-09-01T07:42:58.102Z
    last_advanced_at  2026-09-01T07:45:59.530Z      = 181 s
    phase             failed
    failure_reason    inner workflow fire failed: fire turn did not settle within the budget
    workflow_run_id   NULL
    worktree          NULL

181 s is exactly `DEFAULT_SETTLE_TIMEOUT_MS = 3 * 60_000` (`trident/liveness.ts:149`).

**But the workflow it fired was alive and building the card.** Measured afterwards:

- worktree `.claude/worktrees/wf_9d6cb66c-408-2` exists, holding
  `trident/switching-back-into-a-project-lands`;
- its reflog: cut from `e651cc3e` (origin/main) at **07:50:36Z**, checked out the card's branch
  at **07:50:51Z** — nearly five minutes AFTER the run was written off;
- its `.trident/plans/trident/switching-back-into-a-project-lands.md` was last written at
  **07:52:13Z**, and opens `Resume state (round 5, post-approve)`, repeating the card's
  round-3 measurements verbatim. It is doing exactly the right work.
- its worktree lock reads `claude agent wf_9d6cb66c-408-2 (pid 2088872 start 122952867)`;
  pid 2088872 is alive, `/proc/2088872/stat` field 22 matches the recorded starttime, and its
  cmdline is `--tools Workflow,Read,Glob,Grep,Write,Edit,Bash,Task,TodoWrite` with cwd at the
  repo root — i.e. the warm `cc-trident-fire-*` substrate, not an owner session.

## The cost, and why it is not a one-off

Because the row said `failed`, the terminal-build wake fired and instructed a relaunch. The
relaunch (`ef81d378-9322-43bb-8f6d-c1ac99f4e117`, 07:51:43Z) was refused 2.5 s later by the
wrong-base guard — the ONLY thing that stopped a second lane building the same branch under
the live one. That guard's refusal was luck, not design: it fires on the branch's shape, not
on the knowledge that a lane is live.

Frequency, measured over `code_trident_runs` for the last 7 days:

    runs started since 2026-08-25 ............................. 33
    failure_reason LIKE '%did not settle within the budget%' ... 8   (24%)
      by day: 2026-08-31 → 6, 2026-09-01 → 2

Two of the eight died at ~the budget on round 1 (`9663fed7` 181 s, `5526224f` 254 s). The other
six died on a LATER round's re-fire, after hours of accepted work — `dfdffc81` at 4 h 08 m,
`13aaacff` at 3 h 59 m (which also stranded 779 uncommitted lines). So the same seam both
discards live work and mislabels live runs.

## The mechanism

`buildSubstrateWorkflowFire` (`trident/inner-loop.ts:826-930`) races `consume()` against
`setTimer(…, input.settle_timeout_ms)`. On timeout it sets `timedOut = true`, calls
`handle.cancel()`, and resolves `{ status: 'failed', error: 'fire turn did not settle within
the budget' }`.

Its own docblock states the design: *"resolve `fired` the instant that turn SETTLES (a
`completion` event) — the workflow keeps running detached."* The failure path silently assumes
the converse — **not settled ⇒ not fired** — and that inference is invalid the moment the
launcher turn has already made its `Workflow` tool call. Cancelling the LAUNCHER does not
cancel the detached workflow; the evidence above is that the workflow proceeded normally for at
least six minutes after the cancel.

## What to build

1. **Never write `failed` without checking for positive evidence that the workflow started.**
   Before persisting the timeout outcome, look for: a workflow run id attributable to this run,
   a worktree whose HEAD is this run's branch created at/after the fire, or brief `.part` files
   consumed. If any is present, the outcome is not `failed` — it is *launched, launcher unobserved*.
2. **Add a distinct outcome for that state** rather than reusing `fired`. `fired` means the
   launcher confirmed; the new state means the workflow is believed live but unconfirmed. It must
   suppress the terminal-build wake's relaunch instruction and must NOT arm a second dispatch.
3. **The wake prompt must not tell an agent to relaunch a run whose workflow may be live.**
   Today the wake says "To retry or resume a failed build … call `work_board_start`". For this
   failure_reason specifically, it must instead say: resolve the branch holder first.
4. **Dispatch must refuse on liveness, not only on branch shape.** A dispatch for a slug whose
   branch is held by a live worktree lock should be refused with that reason, so the wrong-base
   guard stops being the accidental last line of defence.

## Do not

- **Do not simply raise `DEFAULT_SETTLE_TIMEOUT_MS`.** It trades one arbitrary number for
  another and still mislabels the run when the new number is exceeded. The defect is the
  inference, not the threshold.
- **Do not cancel the detached workflow on launcher timeout.** It is doing real work — in the
  observed case it was carrying a correct, fully-specified round-5 resume.
- Do not change `handle.cancel()` on the launcher turn itself; cancelling a wedged launcher is
  correct and is not what causes this.

## Verification

Must-fail control: a fire whose launcher never settles, where the seam is given positive
evidence that the workflow started (a worktree on the run's branch created after the fire).
Assert the run is NOT recorded with the terminal `failed` phase and that a subsequent dispatch
for the same slug is refused. Against today's code that test must FAIL — today the outcome is
unconditionally `{ status: 'failed' }` on timeout. Must-pass sibling: a fire whose launcher
never settles AND for which no such evidence exists still records `failed` exactly as now.

---

_Canonical plan for this Plan card. The build reads this doc as its spec; the planning stage elaborates it as work proceeds._

## SECOND SHAPE, measured 2026-09-01 — the run had already BUILT AND PUBLISHED, and the row said `failed`

The original evidence above is the *live workflow* case. Twice more on the same day the same
timeout fired at the END of a complete, successful cycle, and the cost was different: nothing was
live and nothing was lost on disk, but a run that had built, tested and PUSHED was recorded as a
failure, and its re-review never happened.

    run 74dc3e77 (PR #490)   inner_checkpoint  outer-published:73533663:0:3   inner_verdict REVIEW_NOT_RUN
    run 8c88c96c (PR #487)   inner_checkpoint  outer-published:88f699e2:0:2   inner_verdict REVIEW_NOT_RUN

In both cases: `remainingTasks 0`, the branch's local ref equal to origin, the PR OPEN and
MERGEABLE at that exact published sha (17/17 CI green on #490), no worktree holding the branch,
and no salvage tag — the work was complete and published. The terminal record nonetheless carried
`verdict: REQUEST_CHANGES` with the PREVIOUS round's number and, on #487, the PREVIOUS round's
`publishHead`. So the row misreports a finished build twice over: as failed, and as rejected.

**This makes requirement 1 cheaper than it looks.** The strongest positive evidence needs no
filesystem probe at all — the run's OWN row already carries `inner_checkpoint` matching
`outer-published:<sha>:<remaining>:<round>`, written by the outer loop when it pushed. A timeout
that is about to write `failed` over a row in that state is provably wrong without touching git.
Treat that as the first check in the evidence list, ahead of the worktree/`.part` probes, and give
it its own must-fail control: a fire whose launcher never settles over a row whose
`inner_checkpoint` says `outer-published:…` must not record `failed`.

The right terminal state here is not "launched, launcher unobserved" — the work is finished. It is
*built and published, review not run*, which is exactly the state the sibling card
`1-measured-cost-97-of-160-rejections-in-30-days-carry-no-fin-fk66ef` is introducing at the write
site. Reuse that state rather than inventing a second name for it, and do not let this seam stamp
`REQUEST_CHANGES` over it.

**Cost, measured:** each occurrence costs a full relaunch cycle — worktree/ref housekeeping, a
resume note, and roughly two hours of lane time to reach the same point again. Three of the five
terminal-build wakes handled on 2026-09-01 were this seam.

---

## RESUME NOTE — round 1 (`8867cc73`) was killed by the substrate, not by a hang. Nothing was built.

Measured 2026-09-01T15:00Z. The run FIRED correctly: `workflow_run_id 909c7917-…`, inner workflow
`wf_2c499125-fa5` spawned 13:26Z. Its agent transcript runs to **13:35:33.338Z** and stops
mid-turn, immediately after a tool result. A sibling inner workflow (`wf_c5687eca-dd2`) stops at
**13:35:21.369Z** — twelve seconds earlier. Two independent lanes ending inside the same 12-second
window is one substrate death, not two agent hangs; the wake's `no progress for 90 min — suspected
agent hang` describes the silence that followed, not the cause.

**Nothing survived and nothing was lost on disk.** No branch `trident/a-fire-turn-settle-timeout-writes-t`
exists locally or on origin, no worktree holds the slug, no `refs/tags/trident-salvage/8867cc73-…`,
no PR. Round 1 spent its nine minutes READING, not writing. So the relaunch starts clean — but it
should not re-derive what round 1 had already found:

### Prior art round 1 located — start here, do not rediscover it

`trident/run-disposition.ts` on `origin/trident/1-measured-cost-97-of-160-rejection` (the sibling
card's branch) is the READING half of the state this card needs. Its own docblock records the
design that constrains requirement 2 of this spec:

- it is **a single pure classifier computed FROM THE EXISTING COLUMNS ALONE** — no new column, no
  backfill, and no rewriting of historical rows, because those rows are the measurement evidence;
- the write-side half has **already landed**: the store refuses a findings-free `REQUEST_CHANGES`
  write, and `REVIEW_NOT_RUN` is the no-review terminal;
- one of its three states is `died-before-build` — *no review ran and this dispatch has no build it
  may resume*.

Therefore requirement 2 ("add a distinct outcome for launched-but-unconfirmed") must be expressed
as a case of that classifier over existing columns. Do **not** add a column, and do **not** invent a
second name for *built and published, review not run* — read the sibling module first and extend
its vocabulary.

The `inner_checkpoint = outer-published:<sha>:<remaining>:<round>` check in the SECOND SHAPE
section above is the cheapest evidence in the requirement-1 list and needs no filesystem probe.
Order the evidence checks with it first.

## Tasks (round 9 — typecheck repair)

- [x] **T7 — green the `typecheck` gate on PR #498: fix the two TS2339 type-narrowing errors at `trident/board-dispatch.test.ts:546` and `:565` by narrowing on the `hold` property (`'hold' in result`) with hard assertions, instead of the ineffective `code !== 'branch_live'` guards.** Test-file-only change; no production code. Both sites replaced: the first site adds `expect('hold' in result).toBe(true)` before the property-presence guard; the second site additionally asserts `expect(result.code).toBe('branch_live')` (previously missing) before the same narrowing. Verified: pre-edit `bunx tsc -p trident/tsconfig.json --noEmit` reproduced exactly the two specified TS2339 errors; post-edit it reports zero errors for `trident/board-dispatch.test.ts`; `bash scripts/ci/typecheck-all.sh` passes `trident/tsconfig.json` cleanly (the worktree needed `bun install` first — `node_modules` was absent, which also explained unrelated pre-existing `no such table`/module-resolution failures across the matrix that are untouched by this change); `bun test trident/board-dispatch.test.ts` — 36 pass, 0 fail.
