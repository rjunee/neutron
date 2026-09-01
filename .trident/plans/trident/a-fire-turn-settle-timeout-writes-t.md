# IMPLEMENTATION_PLAN — a fire-turn settle timeout writes the run off as `failed` while the workflow it launched is still building (Plan card `fk…`)

Card: `buildSubstrateWorkflowFire` (trident/inner-loop.ts) resolves `{status:'failed', error:'fire turn did not settle within the budget'}` on launcher-settle timeout, and the orchestrator (`orchestrator.ts` `outcome.status !== 'fired'` branch) unconditionally terminalized the run — but "not settled" does NOT imply "not fired". Measured: 8 of 33 runs in 7 days; the wake then invites a second lane onto a branch a live lane holds (stopped only by wrong-base-guard luck), and twice the timeout wrote `failed` over a run whose own row said `outer-published:*` (built, pushed, CI green). Fix in four layers: (1) never write plain `failed` on settle-timeout without checking positive evidence the workflow started — the run's own `inner_checkpoint` first, filesystem probes second; (2) a distinct launched-but-launcher-unobserved outcome that holds the lane instead of terminalizing, expressed over EXISTING columns only (no new column, no new phase); (3) the terminal-build wake must not tell an agent to relaunch for this failure shape — resolve the branch holder first; (4) dispatch must refuse on branch LIVENESS (live worktree lock / non-terminal run on the branch), not only on branch shape.

## Resume state (round 8, 2026-09-01 — ARGUS ROUND-4 FINDINGS ADDRESSED; T1–T6 unchanged in shape)

Round 8 repaired the seams Argus round 4 measured. No new column, no new phase, no new module.
**Decision 10 was AMENDED this round** (see the decision record below) to record the deviation
round 7 had already shipped without reporting; `deviatedFromSpec: true` is reported for that
amendment alone.

- **BLOCKER — the lost-update race survived the final row re-read.** Carrying `observed`
  forward NARROWS the window between the gatherer's last read and `saveIfActive`; it cannot
  close it, because those are two statements. `saveIfActive` now takes an OPTIONAL
  `workflow_columns_seen` (`store.ts`, the exported `WorkflowColumnsSeen` type) and writes
  `inner_checkpoint` / `inner_verdict` as `CASE WHEN <col> IS ?seen THEN ?new ELSE <col> END` —
  a per-column compare-and-swap. `AdvanceOutcome.workflow_columns_seen` carries it from the
  orchestrator's two evidence arms through `tick.ts`. A caller that loses the CAS still commits
  every other column, so no save is ever dropped; every caller that passes nothing is
  byte-identical.
- **MAJOR — a worktree-only `branch_live` hold had no self-drain.** Its holder is a bare pid,
  and a pid exiting fires no terminal observer. `buildDispatchHoldSweep`'s run argument is now
  optional and `TridentTickLoop` gained `drain_dispatch_holds`, called once per tick body
  (failure-contained exactly like the as-built catch-up), wired composition-root →
  `open/composer.ts`. The sweep re-runs EVERY gate, so a still-live branch simply refreshes its
  row.
- **MAJOR — the published classifier ignored `remaining`.** `outer-published:<sha>:1:1` — a
  governed round pushed with tasks still UNBUILT — was terminalized as finished-and-published,
  which forbids the rebuild the card actually needs. `classifyFireTimeoutRow` now requires
  `remaining === 0`; anything else falls through to `none` and the ordinary recoverable `failed`.
- **MAJOR — decision 10 contradicted without truth-sync.** Amended below; the in-code comment
  at the gate already defended the ordering, and the hold is now recorded as intended, not as
  an accident.
- **MINOR — the `branch_live` refusal contradicted its own behaviour.** It said "Nothing was
  dispatched … Re-dispatch only once…" while the same block queued the card. The message now
  says QUEUED, and the result carries a `hold` field like the other two queueing refusals.
- **MINOR — the wake forbade the resume it should ask for.** "…and no published work exists"
  is unsatisfiable for a published row, and `inner-workflow.mjs`'s `resumeOnUnchangedHead`
  resumes an `outer-published` head as mode `review`. The instruction now says so.
- **MINOR — owner-facing delivery led a finished, pushed build with ❌.** New
  `FailureClass 'published-unreviewed'` with its own `composeTerminalDelivery` arm (📦), the
  same carve-out shape `infra-blocked` already had; every other class keeps ❌ byte-identical.
- **Recorded, not fixed (unchanged from round 7):** the flagship run (`9663fed7`) would still
  land `failed` at t=181 s — at that instant no worktree existed and the row could not have
  moved. The as-built entry says so plainly.
- **NITs left alone, deliberately:** the live-holder wait path's per-tick `git worktree list`
  (churn, matching the existing per-tick `probe_run_alive` design) and dispatch's advisory
  (non-atomic) branch read (the claimed-paths transaction remains the only serializer). Both
  are pre-existing design shapes, not defects this diff introduces.

## Resume state (round 7, 2026-09-01 — ARGUS ROUND-1 FINDINGS ADDRESSED; T1–T6 unchanged in shape)

The four layers stand exactly as specced; round 7 repaired the seams Argus measured, all
inside the same files. No new column, no new phase, no new module.

- **BLOCKER — the outer save wrote pinned columns back over a live workflow's.** `saveIfActive`
  assigns `inner_checkpoint`/`inner_verdict` plainly, so sparing a live lane erased in the same
  statement the delta that proved it live. `FireTimeoutEvidence` now carries `observed` (the
  FRESH workflow-owned columns, narrowed by `pickWorkflowOwned` so an outer-owned column can
  never ride back), and the orchestrator spreads it over `pinnedRun` on BOTH the held and the
  published returns. Pinned by an integration test that checkpoints from inside the gatherer and
  asserts the value survives the tick's own save.
- **BLOCKER — the hold did not survive a restart.** New orchestrator option
  `probe_branch_holder`, wired at the composition root to `defaultBranchHolderProbe`. Orphan
  recovery consults it before the default `redispatch` clears the slot: a live lock on the run's
  branch WAITS instead of firing a second lane. Positive-only — null/non-live/throw redispatch
  exactly as before, and the 90-min reaper + 2 h ceiling (both evaluated earlier in `step()`)
  still bound the wait.
- **MAJOR — `published` short-circuited the worktree probe.** Every re-fired round carries the
  previous round's `outer-published:…`, so decision 4's "a live delta OUTRANKS outer-published"
  now applies to the filesystem too: only a row DELTA short-circuits; `published` falls through
  to `probeBranchHolder` and a live holder wins.
- **MAJOR — the hold sweep deleted `branch_live` holds.** That code is transient by construction;
  `dispatch-holds.ts` now `continue`s on it exactly as it does on `held`, so the queued card is
  re-asked next sweep instead of being silently dropped.
- **MINOR — the held row's `workflow_run_id`.** Now `null`, never a minted or inherited
  generation: a stale one would let the tick's liveness probe latch a live lane as crashed.
- **MINOR — owner-facing copy.** `interpretFailure` matches `FIRE_PUBLISHED_REASON_MARKER`
  explicitly instead of falling to the generic tail's "Reply to retry the build".
- **NITs.** `nowMs()` at the fire site (a NaN clock silently disabled the mtime evidence);
  `log.error('fire_evidence_probe_failed')` instead of a bare `catch {}`; `publishedFailureReason`
  shortens BY FIELD (only the sha is abbreviated; a capped `remaining` shows a visible `…`), so
  the round and `:deviated` are never silently eaten; the `OUTER_PUBLISHED_CHECKPOINT` docblock
  no longer claims to be character-for-character identical to run-disposition's copy (it adds
  capture groups) — the dedupe note stands.
- **Recorded, not fixed:** the flagship run (`9663fed7`) would still land `failed` at t=181 s —
  at that instant no worktree existed and the row could not have moved. The as-built entry says
  so plainly, and names why the card's other two evidence sources are not implementable today
  (the production persistent-REPL adapter emits no `tool_call` events; the brief `.part` files
  are written by the launcher BEFORE the fire).

## Resume state (round 6, 2026-09-01 — ALL TASKS T1–T6 committed; plan COMPLETE)
Branch `trident/a-fire-turn-settle-timeout-writes-t` (LOCAL ONLY — not on origin), tip after this round's commit (see structured result), sitting directly on origin/main @ `e651cc3e` (re-verified this round via `git fetch origin main`: origin/main has NOT moved; merge-base = e651cc3e; the shared checkout's local `main` is behind — irrelevant; NEVER rebase, keep committing on the branch). Commits: `91e85cd2` = T1 (pure `trident/fire-evidence.ts` leaf + orchestrator `gather_fire_evidence` seam; `launched` holds the lane with a `fire-unobserved-launch` stamp, `published` terminalizes via `failedRun(pinned, publishedFailureReason(...), false)`, `none`/throw/unwired byte-identical). `afb97906` = T2 (`trident/fire-evidence-probes.ts`: row re-read first, then branch-holding linked worktree with live-lock pid signal-0 + /proc starttime recycled-pid check; exported `parseWorktreeList`/`probeBranchHolder`/`parseProcStartTime`). `76a85ebb` = T3 (composition-root wiring in `gateway/composition/build-core-modules.ts` + composed wiring test, scenarios A/B/C, A and B recorded red first). `4483cd46` = T4 (dispatch refuses `branch_live` immediately after `const branch = \`trident/${slug}\`` in `trident/board-dispatch.ts`, before the `already_landed` probe; new exported `defaultBranchHolderProbe` in fire-evidence-probes; `WorkBoardStartResult` hand-copied union in `gateway/http/work-board-surface.ts` widened same commit; refusal names the holder, creates no run, upserts no hold; `dispatch-holds.test.ts` duplicated task text differentiated to preserve the path-hold pin). This commit = T5 (`gateway/proactive/terminal-build-wake.ts` `buildTerminalBuildWakePrompt`: instruction 2 rewritten to a resolve-the-branch-holder-first instruction when `run.failure_reason` contains `FIRE_SETTLE_TIMEOUT_ERROR` or `FIRE_PUBLISHED_REASON_MARKER`, imported from the pure `trident/fire-evidence.ts` leaf; every other reason byte-identical, pinned by asserting the exact original instruction-2 line survives verbatim; tests A/B recorded red first against `4483cd46`). Remaining: NONE — T6 committed this commit. Verified this round: orchestrator writes the timeout reason as `inner workflow fire failed: ${outcome.error}` (orchestrator.ts ~3530), so the terminal row's failure_reason CONTAINS `FIRE_SETTLE_TIMEOUT_ERROR` as a substring; `publishedFailureReason()` output CONTAINS `FIRE_PUBLISHED_REASON_MARKER`; the only prompt-byte consumers are `gateway/proactive/terminal-build-wake.ts` and its unit test — `open/__tests__/open-terminal-build-wake-wiring.test.ts` keys only on the `[TERMINAL BUILD WAKE]` header and needed no edit (verified green).

## Prior art — read, do not rediscover
- `trident/fire-evidence.ts` (T1, on this branch): the pure leaf. `FIRE_SETTLE_TIMEOUT_ERROR = 'fire turn did not settle within the budget'`, `FIRE_PUBLISHED_REASON_MARKER = 'already built and published'`, `publishedFailureReason(checkpoint)`. T5 imports the two constants from THIS module (I/O-free), never from `fire-evidence-probes.ts`.
- `gateway/proactive/terminal-build-wake.ts` already imports trident modules (`state-machine.ts`, `store.ts`) — the layering gate permits the new import; trident/package.json has no exports map, direct `.ts` subpaths are the convention.
- `trident/run-evidence.ts` + `trident/run-evidence-probes.ts` (main, #488): evidence-probe discipline this branch mirrors. Reuse exports; do not duplicate.
- `origin/trident/1-measured-cost-97-of-160-rejection` → `trident/run-disposition.ts` (sibling branch, NOT on main): column-only terminal taxonomy; its `OUTER_PUBLISHED` regex is mirrored character-for-character into `fire-evidence.ts` with a dedupe note. Do NOT import across branches.
- `failedRun` (orchestrator.ts) normalizes the verdict; `interpretFailure` (trident/delivery.ts) routes failure classes by keywords; `publishedFailureReason` avoids every classifier token.
- Leak gate: no absolute machine-local filesystem paths in code, details, tests, or commit messages; basenames + pids only.
- Test runner: `bash scripts/run-tests.sh` for the whole suite (bounded memory); bare `bun test <file>` for single files. Typecheck: `bash scripts/ci/typecheck-all.sh`. Layering gate: `bash scripts/ci/lint.sh`.

## Decision record (locked; do not re-litigate)
1. **Positive evidence or nothing.** Only POSITIVE evidence may change the timeout outcome; a throwing/blind/failed probe keeps today's `failed`. Deliberate INVERSE of `decideHang`'s unknown-defers rule. Late evidence (worktree appears minutes after the timeout — the observed incident) is covered by layers 3+4, not by guessing: which is exactly why T5 must stay cautious even though T1 now catches the probeable cases.
2. **`launched` holds the lane, non-terminal** — mirrors the `fired` return minus the settle stamp; the stall guard + run-scoped-evidence watchdog own liveness from there. Zero new columns/phases. (A held lane never wakes — `isTerminalPhase` gates the observer — so T5 concerns only rows that still terminalize as `failed`.)
3. **`published` terminalizes honestly**: phase `'failed'`, failure_reason = `publishedFailureReason(checkpoint)` carrying the marker, verdict `REVIEW_NOT_RUN`, checkpoint preserved — `built-never-reviewed` under the sibling classifier, never `reviewed-rejected`.
4. **Row evidence FIRST (cheapest, no filesystem); live-delta OUTRANKS `outer-published`.**
5. **Gate scoped to `outcome.error === FIRE_SETTLE_TIMEOUT_ERROR` exactly**; every other fire error byte-identical.
6. **Card do-nots stand:** `DEFAULT_SETTLE_TIMEOUT_MS` untouched; the detached workflow is never cancelled; launcher `handle.cancel()` unchanged.
7. **Evidence sources are the row re-read + branch-holding worktree, not scratch `.part` files** (run id spans rounds; an old-round artifact would fabricate launch evidence).
8. **A live lock outranks mtime staleness**; a recycled pid (starttime mismatch) is NOT live.
9. **Fire gatherer wired unconditionally, default-constructed except `read_run`**; probes carry their own 15 s host bound.
10. **T4 refuses with `branch_live` — AND QUEUES — AFTER `already_landed`.** AMENDED round 8;
    the original text read *"a REFUSAL, not a hold, immediately after branch computation, BEFORE
    `already_landed`"* and round 7 shipped the opposite without reporting the deviation. What is
    locked now, and why:
    - **Order: after `already_landed`.** Both refuse and both dispatch nothing, so the only thing
      at stake is which sentence the operator reads — and "already merged as #N, verify the card"
      is strictly more actionable than "something is building this branch" for a card whose work
      has SHIPPED. Cost of the swap is one `gh` call on the rarer path. The in-code comment at the
      gate carries this argument.
    - **It queues.** Without a hold row the card is dropped on the floor and only a human
      re-dispatching revives it, while the path-claim gate twenty lines below — refusing on the
      SAME fact, "a live run owns this" — has always queued. The sweep re-runs EVERY gate, so a
      still-live branch refreshes the row and a freed one dispatches; nothing auto-fires onto a
      live branch. Stored `hold_kind` stays `'path'` (migration 0139 pins that CHECK); the result's
      `hold.kind` is `'branch'` and is a SURFACE discriminator only.
    - Unchanged from the original: two positive checks (non-terminal same-branch row;
      branch-holding worktree under a live lock pid), no mtime at dispatch, the refusal names the
      holder and never advises deleting the branch.
    - The refusal text must MATCH the behaviour (it says QUEUED) and carry a `hold` field, like
      the other two queueing refusals.
11. **`WorkBoardStartResult` union widened in the same commit as any rejection-code change** (done in `4483cd46`).
12. **T5 keys on SUBSTRING containment of the two shared constants in `run.failure_reason` (null → no match), edits ONLY instruction 2, and the non-matching prompt stays byte-identical** — pinned by asserting the exact original instruction-2 line survives verbatim for other reasons. (Confirmed this round: implementation matches decision exactly; all 10 tests in `terminal-build-wake.test.ts` green, including the two new red-first controls and the byte-identical-elsewhere pin.)

## Tasks
- [x] **T1 — settle-timeout evidence gate at the orchestrator's fire-fail seam** (committed `91e85cd2`). Pure `trident/fire-evidence.ts` + tests; `inner-loop.ts` literals → shared constant; orchestrator's optional `gather_fire_evidence` seam consulted only on the settle-timeout error; red-first controls passed; unwired seam byte-identical.
- [x] **T2 — production evidence gatherer** (committed `afb97906`). `trident/fire-evidence-probes.ts` (fresh-row re-read first, then the branch-holding linked worktree; live-lock pid with recycled-pid starttime check; positive-only; basenames + pids only) + exported `parseWorktreeList`/`probeBranchHolder`/`parseProcStartTime`, full unit suite.
- [x] **T3 — wire the gatherer at the composition root** (committed `76a85ebb`). `build-core-modules.ts` passes `gather_fire_evidence` beside `gather_run_evidence`; composed wiring test proves A (live lock → lane held), B (`outer-published:*` row → published/review-not-run), C (no evidence → byte-identical `failed`); A and B recorded red first.
- [x] **T4 — dispatch refuses on branch liveness (card req 4)** (committed `4483cd46`). `branch_live` gate in `trident/board-dispatch.ts` per decision 10 AS AMENDED IN ROUND 8 (it runs after `already_landed` and it QUEUES — the plan text now matches the code); `defaultBranchHolderProbe` exported from fire-evidence-probes; `work-board-surface.ts` union widened; full red-first refusal suite in `board-dispatch.test.ts`; `dispatch-holds.test.ts` path-hold intent preserved via differentiated task text.
- [x] **T5 — the wake stops inviting a relaunch for this failure shape (card req 3)** (committed this commit). `gateway/proactive/terminal-build-wake.ts` `buildTerminalBuildWakePrompt`: when `run.failure_reason` contains `FIRE_SETTLE_TIMEOUT_ERROR` or `FIRE_PUBLISHED_REASON_MARKER` (imported from the pure `trident/fire-evidence.ts` leaf), instruction 2 is replaced with do-NOT-relaunch-yet guidance: resolve the branch holder first (`git worktree list --porcelain` lock + live pid, the run row's `inner_checkpoint`, the PR state); for the published marker, verify the PR and dispatch a REVIEW round, never a rebuild; re-dispatch via `work_board_start` only when nothing live holds the branch and no published work exists. Every other failure_reason (including null) renders a byte-identical prompt — pinned by asserting the exact original instruction-2 line verbatim. New tests recorded red first.
- [x] **T6 — record it** (committed this commit)**.** Staged the `.trident/as-built/trident/a-fire-turn-settle-timeout-writes-t.md` entry (`docs/AS_BUILT.md` untouched, per the one-writer rule) covering the four layers + the measured evidence; truth-synced this plan and the `.trident/plans` card doc.

## Verification map (card's controls)
- Must-fail 1 (live evidence): T1 orchestrator `launched` seam — done; T2 real-probe half — done; T3 scenario A composed — done; "subsequent dispatch refused" completed in T4's combined control + live-lock test — done.
- Must-fail 2 (`outer-published` row): T1 pure-classifier + orchestrator tests — done; T2 no-git-probe pin — done; T3 scenario B composed — done.
- Must-pass sibling (no evidence): T1 byte-identical `failed` — done; T2 stale/dead/failed-probe → `none` — done; T3 scenario C composed — done.
- Dispatch liveness (card req 4): T4 suite — done, refusal cases recorded red first against `76a85ebb`.
- Wake prompt (card req 3): T5 tests — done. Timeout/published reasons rewrite instruction 2 (recorded red first against `4483cd46`); every other reason keeps the original instruction-2 line byte-for-byte (green before and after).
- Commit .trident/plans/trident/a-fire-turn-settle-timeout-writes-t.md together with your code + tests.
- Report `deviatedFromSpec: true` in your structured result ONLY if you materially deviated from the EXECUTION SPEC above (different target files, a different design, or the task as built is not the task as specced) — a true here forces the next iteration to re-derive the whole plan, so do not set it for cosmetic drift. Otherwise report false or omit it.
