# IMPLEMENTATION_PLAN — a fire-turn settle timeout writes the run off as `failed` while the workflow it launched is still building (Plan card `fk…`)

Card: `buildSubstrateWorkflowFire` (trident/inner-loop.ts) resolves `{status:'failed', error:'fire turn did not settle within the budget'}` on launcher-settle timeout, and the orchestrator (`orchestrator.ts` `outcome.status !== 'fired'` branch) unconditionally terminalized the run — but "not settled" does NOT imply "not fired". Measured: 8 of 33 runs in 7 days; the wake then invites a second lane onto a branch a live lane holds (stopped only by wrong-base-guard luck), and twice the timeout wrote `failed` over a run whose own row said `outer-published:*` (built, pushed, CI green). Fix in four layers: (1) never write plain `failed` on settle-timeout without checking positive evidence the workflow started — the run's own `inner_checkpoint` first, filesystem probes second; (2) a distinct launched-but-launcher-unobserved outcome that holds the lane instead of terminalizing, expressed over EXISTING columns only (no new column, no new phase); (3) the terminal-build wake must not tell an agent to relaunch for this failure shape — resolve the branch holder first; (4) dispatch must refuse on branch LIVENESS (live worktree lock / non-terminal run on the branch), not only on branch shape.

## Resume state (round 14, 2026-09-02 — BUILD COMPLETE AND GREEN; this round is VERIFICATION-ONLY so a valid review can finally run)

Measured this round from the repo of record:

- **PR #498 is OPEN at `cb913e03`, MERGEABLE / CLEAN, 17 of 17 checks SUCCESS** (typecheck
  included — T7's fix is live in CI). The local branch ref equals `origin`'s equals the PR head.
  Merge-base with `origin/main` IS `origin/main` (`bee6dfd9`), so the PR diff is exactly this
  branch's 8 commits — 32 files, ~5.2k insertions. Tag `trident-built/33661a9b-fire-evidence`
  marks the tip as the built state. No worktree holds the branch; no salvage tag descends from
  the tip; nothing is uncommitted anywhere. **There is no code left to build.**
- **Run `33661a9b` addressed the PR review cycle's Argus r3/r4 as commits `05faca77` and
  `cb913e03` (rounds 12–13 below), then was killed at its round 5 by a gateway restart**
  (generation e47d0e; row says `stopped` / "cancelled via codegen_cancel"). That is one
  substrate event, not a defect in this branch.
- **The Argus round-5 review it never got to answer is INVALID and must not be acted on.** The
  seat was handed a 23,421-line / 149-file diff taken against the repo of record's local
  `main`, ten days behind `origin/main`; its 3,000-line budget was spent on foreign files and
  its three blockers + one minor cite `GLOSSARY.md`, `docs/INVARIANTS.md`,
  `scripts/ci/as-built-write-guard.sh`, `docs/AS_BUILT.md`, `CONTRIBUTING.md`,
  `app/__tests__/chat-keyboard-taps-ask.test.tsx` and other cards' plan docs — none of which is
  in this branch's 32-file diff. The stale-base defect (`writeResumeDiff` naming the base by
  bare branch name) is tracked on its OWN card; do not fix it here.
- **The relaunch attempt after the restart (run `6948da2d`, 09:47Z today) itself died to the
  very settle-timeout defect this branch fixes** — round 1, no workflow started, honest
  `failed`. A live demonstration of the card's economics; no action needed.
- Ops note, recorded not tasked: stray origin branch `trident/resume-note-round-5-already-built-a`
  (empty, sitting at origin/main) awaits deletion by whoever owns remotes. Not this round's job.

**This round = T9 only: zero source changes.** Re-prove the tip green locally (full suite,
typecheck matrix, layering lint), truth-sync this plan and the `.trident/plans` card copy in a
single docs-only commit on top of `cb913e03`, and settle. A fresh forge/Argus round then reviews
the branch's real diff against pinnedBase (origin/main as observed at launch) instead of round
5's stale-base artefact. Never rebase; never merge main; the publisher owns origin.

- Verified this round: full suite RAN to its coverage audit and 5 of 16 lanes carried failures — every failing file is OUTSIDE this branch's 32-file diff. `landing/__tests__/server.test.ts` plus the three `landing/__tests__/chat-react-*` files and the five failing `app/__tests__/*.tsx` device-lane files PASS on isolated re-run (lane-composition flake, no diff of mine in their import graph); `tests/integration/install-gbrain.test.ts`, `tests/integration/install-codex.test.ts`, `gateway/wiring/__tests__/build-gbrain-memory.test.ts`, `gbrain-memory/__tests__/resolve-gbrain-command.test.ts` and `tests/integration/github-credential-wired.open.test.ts` fail twice here AND fail identically (15 fail / 88 pass) at base `bee6dfd9` in a scratch worktree — host-environment: a real gbrain and codex binary are installed on this box and a token is present in the ambient env, which is exactly what those tests assert is absent; CI is green at `cb913e03`. Typecheck matrix: `trident/tsconfig.json` PASS (and `open/`, `work-board/`, `wire-types/`, `watchdog/` PASS), root-project pre-existing errors noted and NOT touched: `whisper-install.test.ts`, `fire-and-forget.test.ts`, `zip-writer.ts`, plus `app/tsconfig.json`'s implicit `@types` resolution — all outside this branch's diff; lint/layering PASS (every gate 0 found).
- Diff shape at commit: git diff cb913e03..HEAD --name-only == IMPLEMENTATION_PLAN.md + the .trident/plans card copy only.
- No source file changed; Argus round-5 findings not acted on (stale-base artefact; files outside this branch's diff).

## Resume state (rounds 12–13, 2026-09-02 — PR-CYCLE ARGUS r3/r4 ADDRESSED; T1–T8 unchanged in shape)

Full detail in `.trident/as-built/trident/a-fire-turn-settle-timeout-writes-t.md` (its "Round 7"
and "Round 8" sections). No new column, no new phase, no new module.

- **Round 12 (`05faca77`, Argus r3): a refusal that queues nothing now deletes what was already
  queued.** The `branch_live` arm stopped leaving a stale hold behind when it refuses without
  queueing; probes, tick and `work-board-surface.ts` adjusted with their suites.
- **Round 13 (`cb913e03`, Argus r4): the "nothing stays queued" rule now governs EVERY
  hold-producing gate.** One `queued` decision above all three gates routes through a single
  `queueHold` whose two arms are "upsert" and "delete whatever is already queued"; every
  refusal's prose says which arm ran. `FIRE_PUBLISHED_REASON_MARKER` became the token
  `[trident:published-unreviewed]` so a failure_reason merely QUOTING the English cannot
  classify as published (cap 200→231, rendered-checkpoint budget unchanged; both directions
  pinned). The production drain wire is pinned source-scoped in
  `open/__tests__/open-dispatch-hold-drain-wiring.test.ts`. The lane-holding save can no longer
  be thrown out of: `saveIfActive` downgrades a findings-less `REQUEST_CHANGES` exactly as
  `failedRun` does. Accepted risk recorded, not built: a `branch_live` hold has no age cap
  (follow-up card).

## History (rounds 6–11) — one line each; full detail in `.trident/as-built/trident/a-fire-turn-settle-timeout-writes-t.md` and git history of this file

- **Round 6 (2026-09-01): T1–T6 all committed** — T1 `91e85cd2` (pure `trident/fire-evidence.ts` leaf + orchestrator `gather_fire_evidence` seam), T2 `afb97906` (`trident/fire-evidence-probes.ts`), T3 `76a85ebb` (composition-root wiring + composed scenarios A/B/C), T4 `4483cd46` (`branch_live` dispatch gate), T5+T6 (wake rewrite + as-built entry) in the round-6 commit.
- **Round 7 (Argus r1):** evidence carries `observed` workflow-owned columns so sparing a lane no longer erases the delta that proved it live; `probe_branch_holder` consulted by orphan recovery so the hold survives a restart; `published` no longer short-circuits the worktree probe; the hold sweep keeps `branch_live` holds; held rows carry `workflow_run_id: null`.
- **Round 8 (Argus r4 of the first cycle):** per-column CAS in `saveIfActive` (`workflow_columns_seen`); tick-driven `drain_dispatch_holds`; `classifyFireTimeoutRow` requires `remaining === 0`; decision 10 AMENDED (gate after `already_landed`, and it queues); `FailureClass 'published-unreviewed'` with its own delivery arm.
- **Round 9: T7** — salvaged typecheck fix `726b92b2` (tag `trident-salvage/d567f33a-…`, parent `3f14fcd0`) landed via ff-merge; docs-only on top (`eb977d7a`).
- **Round 10 (`4b31f660`, Argus r5):** multi-entry branch-holder probe preferring a LIVE holder; `DISPATCH_HOLD_DRAIN_MIN_INTERVAL_MS` floor; honest `branch_live` prose + conditional `hold`; trimmed checkpoint written while the CAS keeps the raw token; duplicate mis-slugged plan doc deleted.
- **Round 11 (`90e9a7d3`, Argus r5 synthesis):** the wake stops promising a `work_board_start` resume that does not exist (`store.create → inner_checkpoint === null` pinned); with no live candidate the holder probe prefers the freshest readable mtime; one `queued` value decides the `branch_live` refusal's prose, write and `hold` field; `fire-unobserved-launch` attributed via `STAGE_ALTERNATIVES`; surrogate-safe `publishedFailureReason` cap.

## Prior art — read, do not rediscover
- `trident/fire-evidence.ts` (T1, on this branch): the pure leaf. `FIRE_SETTLE_TIMEOUT_ERROR = 'fire turn did not settle within the budget'`, `FIRE_PUBLISHED_REASON_MARKER` (the token `[trident:published-unreviewed]` since round 13), `publishedFailureReason(checkpoint)`. T5 imports the two constants from THIS module (I/O-free), never from `fire-evidence-probes.ts`.
- `gateway/proactive/terminal-build-wake.ts` already imports trident modules (`state-machine.ts`, `store.ts`) — the layering gate permits the new import; trident/package.json has no exports map, direct `.ts` subpaths are the convention.
- `trident/run-evidence.ts` + `trident/run-evidence-probes.ts` (main, #488): evidence-probe discipline this branch mirrors. Reuse exports; do not duplicate.
- `origin/trident/1-measured-cost-97-of-160-rejection` → `trident/run-disposition.ts` (sibling branch, still NOT on origin/main — re-verified round 14): column-only terminal taxonomy; its `OUTER_PUBLISHED` regex is mirrored into `fire-evidence.ts` with a dedupe note. Do NOT import across branches.
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
    - The refusal text must MATCH the behaviour (since rounds 12–13: one `queued` value decides the
      prose, the write and the `hold` field, at EVERY hold-producing gate).
11. **`WorkBoardStartResult` union widened in the same commit as any rejection-code change** (done in `4483cd46`).
12. **T5 keys on SUBSTRING containment of the two shared constants in `run.failure_reason` (null → no match), edits ONLY instruction 2, and the non-matching prompt stays byte-identical** — pinned by asserting the exact original instruction-2 line survives verbatim for other reasons.

## Tasks
- [x] **T1 — settle-timeout evidence gate at the orchestrator's fire-fail seam** (committed `91e85cd2`). Pure `trident/fire-evidence.ts` + tests; `inner-loop.ts` literals → shared constant; orchestrator's optional `gather_fire_evidence` seam consulted only on the settle-timeout error; red-first controls passed; unwired seam byte-identical.
- [x] **T2 — production evidence gatherer** (committed `afb97906`). `trident/fire-evidence-probes.ts` (fresh-row re-read first, then the branch-holding linked worktree; live-lock pid with recycled-pid starttime check; positive-only; basenames + pids only) + exported `parseWorktreeList`/`probeBranchHolder`/`parseProcStartTime`, full unit suite.
- [x] **T3 — wire the gatherer at the composition root** (committed `76a85ebb`). `build-core-modules.ts` passes `gather_fire_evidence` beside `gather_run_evidence`; composed wiring test proves A (live lock → lane held), B (`outer-published:*` row → published/review-not-run), C (no evidence → byte-identical `failed`); A and B recorded red first.
- [x] **T4 — dispatch refuses on branch liveness (card req 4)** (committed `4483cd46`). `branch_live` gate in `trident/board-dispatch.ts` per decision 10 AS AMENDED (after `already_landed`, and it queues); `defaultBranchHolderProbe` exported from fire-evidence-probes; `work-board-surface.ts` union widened; full red-first refusal suite in `board-dispatch.test.ts`.
- [x] **T5 — the wake stops inviting a relaunch for this failure shape (card req 3)** (round 6). `buildTerminalBuildWakePrompt`: when `run.failure_reason` contains `FIRE_SETTLE_TIMEOUT_ERROR` or `FIRE_PUBLISHED_REASON_MARKER`, instruction 2 becomes resolve-the-branch-holder-first guidance; every other reason byte-identical, pinned verbatim. (Round 11: the prompt no longer promises a `work_board_start` resume that does not exist.)
- [x] **T6 — record it** (round 6). `.trident/as-built/trident/a-fire-turn-settle-timeout-writes-t.md` entry (`docs/AS_BUILT.md` untouched, per the one-writer rule); plan + `.trident/plans` card doc truth-synced. Extended every subsequent round.
- [x] **T8 — Argus round-5 findings** (rounds 10–11, `4b31f660` + `90e9a7d3`). Multi-entry branch-holder probe; drain floor; honest `branch_live` queue prose; hard-asserted refusal code; trimmed checkpoint at the write site with raw CAS token; duplicate plan doc removed.
- [x] **T7 — land the salvaged typecheck fix (round 9).** `git merge --ff-only 726b92b2` (tag `trident-salvage/d567f33a-83f7-43d6-aa7a-db07a0bd2ee6`, parent `3f14fcd0`); no hand edits, no production diff; `trident/board-dispatch.test.ts` narrowing fixed; CI `typecheck` now SUCCESS on PR #498.
- [x] **T10 — PR-cycle Argus r3/r4 findings** (rounds 12–13, `05faca77` + `cb913e03`). See the rounds 12–13 resume state: single `queued` decision + `queueHold` across all three gates; marker token `[trident:published-unreviewed]`; source-scoped drain-wire pin; throw-proof lane-holding save; accepted no-age-cap risk recorded.
- [x] **T9 — verification-only settle round (round 14).** ZERO source changes. Re-prove tip `cb913e03` locally: full suite (`bash scripts/run-tests.sh`), typecheck matrix (`bash scripts/ci/typecheck-all.sh` — `trident/tsconfig.json` must PASS), layering/lint (`bash scripts/ci/lint.sh`). Then commit ONLY the truth-synced docs (this file + the `.trident/plans` card copy) on top of `cb913e03` and settle, so the next Argus round reviews the branch's real ~5.2k-line diff against pinnedBase instead of round 5's stale-base 23k-line artefact. Do NOT act on Argus round-5 findings (they cite files outside this branch's diff); do NOT rebase or merge main; do NOT push (the publisher owns origin); do NOT touch production or test code. (verified this round — see round-14 note.)

## Verification map (card's controls)
- Must-fail 1 (live evidence): T1 orchestrator `launched` seam — done; T2 real-probe half — done; T3 scenario A composed — done; "subsequent dispatch refused" completed in T4's combined control + live-lock test — done.
- Must-fail 2 (`outer-published` row): T1 pure-classifier + orchestrator tests — done; T2 no-git-probe pin — done; T3 scenario B composed — done.
- Must-pass sibling (no evidence): T1 byte-identical `failed` — done; T2 stale/dead/failed-probe → `none` — done; T3 scenario C composed — done.
- Dispatch liveness (card req 4): T4 suite — done, refusal cases recorded red first against `76a85ebb`; hold semantics re-pinned end to end in rounds 12–13.
- Wake prompt (card req 3): T5 tests — done; round-11/13 re-pins (no false resume promise; token-based published match).
- Round-14 settle: `git diff cb913e03..HEAD --name-only` is EXACTLY `IMPLEMENTATION_PLAN.md` + `.trident/plans/trident/a-fire-turn-settle-timeout-writes-t.md`; suite/typecheck/lint outcomes appended to the round-14 resume note; the structured report's `testsPassed` matches the suite outcome actually observed (round-10 lesson: a self-contradictory report is read as no proof).
