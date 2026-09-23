## 2026-09-23 — A retry resumes a handed-back Ralph iteration from its committed ledger, and says on the card what it carried

Spec item `docs/spec-items/a-retry-must-resume-from-the-checkpoint.md`, now `status: done`.
The earlier record for the same item is `docs/as-built/a-retry-must-resume-from-the-checkpoint.md`
(#628); it stays as written, because a merged shard is never edited.

### Why the item was still open

Three gaps, measured before this change. A retry that declined to resume was a byte-identical
fresh dispatch whose only trace was a `dispatch_resume_seed` log line, which no one looking at
the card sees. A governed run that died after handing back a finished Ralph iteration
(`ralph-task-built`) was re-dispatched with `inner_checkpoint = null`, so the retry paid the full
planning survey again. And the Ralph spend rode `linked_run_id`, so one status-advance off the
`failed` lane handed the same card a fresh budget (rjunee/neutron#629).

### What changed

**The retry can resume a Ralph handoff.** `retryModeSource` (`trident/build-mode-state.ts:86`)
accepts a typed `ralph-task-built` state on a governed prior as a continuation source.
`ralph-task-built-deviated` stays refused: a deviated build left a committed plan the code no
longer matches, so its retry must re-plan in full. The dispatch seeds the new row with the
checkpoint, its head and the base pin, and raises the row's round to the iteration the handoff
advanced to — tighten-only, reason `resumed_continuation`. `seedableCheckpoint`
(`trident/run-disposition.ts:160`) and `TridentRunStore.create` (`trident/store.ts:700`) admit
that one non-review name on governed rows only.

**The tip is proved against the LOCAL ref in every merge mode.** An iteration commits locally
and hands back without publishing, so in `pr` mode origin lags the recorded head and in `local`
mode there is no origin to ask at all. A remote read — the shape of the fire-time
`detectExistingPr` probe — cannot be what recovers continuity, so the dispatch reads the same
local ref `prepareLaunch` re-verifies at launch.

**The host commits the Ralph task ledger at each handoff.** The cheap continuation planner (G026,
`trident/build-run.ts:349-366`) reads `IMPLEMENTATION_PLAN.md` at the branch tip, and nothing in
the typed host wrote that file: the probe found main's stale copy with no unchecked boxes and
every continuation re-planned from scratch. The driver now renders the ledger with the finished
task ticked, commits it alone through `commitPlan` (`trident/production-host-effects.ts`), re-measures,
and only then hands the head to the next iteration. The FINAL iteration does not commit it:
review and publication bind every worker receipt (suite checkpoint, mutation nomination,
publication body) to the head the builder reported, and a host commit on top of that head left
the reviewed head with no receipt, so no multi-task card could merge. G025 now also refuses a
Ralph plan whose unchecked lines disagree with its `topTask`/`remainingTasks`.

**The card states the decision.** Migration `0155_trident_resume_note.sql` adds
`code_trident_runs.resume_note`. `resumeNote()` (`trident/board-dispatch.ts:165-178`) builds one
sentence from the very seed, round and cap the row is created with, so card and row cannot
disagree. It is null only for `no_prior_terminal_run` — a first dispatch has nothing to state —
and names the carried checkpoint or the reason it was not carried, plus the Ralph round and cap
for a governed run. No path, host or identity is interpolated. The column is written once, at
create (`trident/store.ts:909`), with no later writer (`:1972`). `run_progress` carries it
(`trident/run-progress.ts:109-113`) and both front-ends render it in `runNotice`
(`app/lib/work-board-helpers.ts:263`, `landing/chat-react/WorkBoardTab.tsx:252`).

### Measured against main (7454048a) and this branch

Gap 1, the card text: closed by the `resume_note` work above.

Gap 2, re-spent planning: closed on the typed build host, and the premise moved. The gap as
written named `trident/inner-workflow.mjs`'s `cleanContinuation`. The launcher a board dispatch
reaches is `open/wiring/project-build.ts` `createProjectBuildHost` → `trident/build-run.ts`
`buildRun`; the legacy workflow substrate is retained but not consumed by the production project
launcher (`open/wiring/substrates.ts:543-544`). On the typed host G026 selects `planner: 'next'`
only for a clean `ralph-task-built` resume, and G029 (`trident/build-run.ts:518-522`) replaces
the planner's claims with the committed bytes. `open/__tests__/project-build-e2e.test.ts:2046-2102`
drives a dead Ralph row through the real `dispatchBoardBoundBuild`, orchestrator step,
`prepareLaunch`, project launcher and `buildRun`, in `local` mode with zero `gh` calls and in
`pr` mode with the iteration unpushed, and asserts planner choices `['next']` and a committed
plan equal to the handoff ledger's exact bytes and sha256. The seed commit carries no ledger and
the worker never writes one, so the only ledger the retry can read is the one the host
committed. Earlier G026 coverage: `docs/as-built/1074-continuation-planner-e2e.md`.

Gap 3, the budget: closed on main before this branch, by #722 and #728. Migrations
`0141_work_board_items_ralph_budget.sql` and `0142_work_board_zero_ralph_cap.sql` put the spend on
the card; reconcile raises `ralph_round` with `MAX` and only tightens the cap with `MIN`
(`work-board/store.ts:1391-1392`), and dispatch refuses an at-cap card with
`ralph_budget_exhausted` from the card's own columns (`trident/board-dispatch.ts:1045-1050`), so
clearing `linked_run_id` (`work-board/store.ts:1257`) no longer resets the spend. #629 closed on
2026-09-14. Not rebuilt here.

### Deliberately not done

`inner-workflow.mjs`'s `cleanContinuation` gate is untouched (`grep -n cleanContinuation
trident/inner-workflow.mjs` → `:5969`); the criterion is measured on the typed host, which is
the loop a board dispatch reaches. The Ralph spend still rides the card's columns, not the run
row; the row is reborn by every dispatch and is not where a budget can live.

### Validation

The moved-tip control in the e2e carries no checkpoint, logs `reason=branch_tip_moved`, keeps
the card's budget, and is refused at launch by the wrong-base guard before any worker runs: a
fresh launch never adopts a branch holding commits it did not make.

Mutation executed on this branch: in `trident/board-dispatch.ts`, widening the null case to
`reason === 'no_prior_terminal_run' || reason === 'branch_tip_moved'` turns
`trident/cross-run-retry-checkpoint.test.ts` red (51 pass, 1 fail: the `branch_tip_moved` note
case) and leaves `trident/store.test.ts` green (158 pass); restored, the guard file is 52 pass.

Replay check: this branch merged onto main 7454048a in a scratch tree and resolved by the rule
below ran 1102 tests across 37 files (every `migrations/` test plus the trident and
project-build files this branch touches): 1101 passed. The one red,
`open/__tests__/project-build-wiring.test.ts`'s credential-exclusion case, reads the shell's
ambient `GH_TOKEN` and `GIT_CONFIG_*` as PRESENT; it reds the same way on this branch
unreplayed, and with those variables unset the file is 33 pass on both trees. Without rule 4
the same run reds `trident/store.test.ts` on the COLS count.

No open PR on the upstream repository adds a migration: the five open PRs at the time of
writing (#1164-#1167, #1171) change no `migrations/0*` file, so 0155 is free.

Verification (replayed onto 7454048a): `bash scripts/ci/lint.sh` exits 0, and
`scripts/ci/typecheck-all.sh` checks 51 tsconfigs, 50 pass. The one FAIL is
`app/tsconfig.json`, `error TS2688: Cannot find type definition file for '@types'` (Entry
point for implicit type library '@types'). It is environmental and not this branch: the same
`tsc --noEmit -p app/tsconfig.json` on the host's main checkout prints the identical single
error and exits 2. The build worktree nests inside that checkout, so tsc's ancestor
`node_modules/@types` walk reaches the host tree, whose `node_modules/@types` holds a
self-referential `@types` symlink. A clean CI checkout has no ancestor `node_modules`.
Pinning `--typeRoots app/node_modules/@types` removes TS2688, and the only error left is
`app/__tests__/support/mount.tsx(17,1) TS2578` (an unused `@ts-expect-error`). That is the
same leak: `--traceResolution` resolves `react-dom/client` to the host tree's
`@types/react-dom`, and this branch does not touch that file.

The nominated proof pair: in `trident/run-progress.ts` replace `    resume_note: run.resume_note,`
with `    resume_note: null,`. `trident/run-progress.test.ts` goes from 40 pass to 39 pass and 1
fail (`carries the dispatch's resume sentence, and null for a first dispatch`), and
`trident/run-disposition.test.ts` stays 50 pass both ways. Neither file applies migrations
through the `@neutronai/migrations` alias, so both are green unmutated in a proof tree that
does not have this branch's 0155.

### The replay rule for ordinal 0154

Main's #1188 took 0154 (`ralph_task_total`) after this branch was cut; 0155 stays. Replaying
onto main conflicts in three files, and one more merges clean and is wrong:

1. `migrations/runner.test.ts` and both applied arrays in
   `migrations/__tests__/live-ledger-125-repair.test.ts` keep 153, 154, 155 in order.
2. Main's `expect(rows.at(-1)).toMatchObject({ version: 154, ... })` is false once 155 applies
   after it; look 154 up with `rows.find((r) => r.version === 154)` and keep its
   `ralph_task_total` table checks.
3. `migrations/expected-schema.txt` comes verbatim from `bun migrations/regen-snapshot.ts`:
   `resume_note TEXT` follows main's `ralph_task_total` CHECK on `code_trident_runs`, and
   `work_board_items` is exactly main's.
4. Both sides moved `trident/store.test.ts`'s COLS count 42 → 43 with identical bytes, so the
   merge is clean at 43 and red. With both columns it is 44 (the table has 45; `agent_waked_at`
   is the one excluded): bump it and say `43 -> 44 with resume_note`.

The same rule sits beside `155,` in `migrations/runner.test.ts`.
