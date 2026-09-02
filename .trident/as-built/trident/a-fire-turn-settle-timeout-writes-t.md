## 2026-09-01 — Trident: a launcher settle timeout is no longer proof the workflow never started

Measured over the 7 days to 2026-09-01, 8 of 33 runs (24%) were terminalized with
`fire turn did not settle within the budget`. The label was wrong in both directions
that matter. In the observed incident a run was written off as `failed` at the 181 s
settle budget while the workflow its launcher had fired kept building the card: the
branch worktree was cut five minutes AFTER the timeout wrote the row, checked out the
run's branch, and wrote a correct resume plan under a lock naming a live pid. The
terminal-build wake then instructed a relaunch, and only the wrong-base guard's SHAPE
check stopped a second lane building the same branch under the live one. Twice more
the same timeout fired at the END of a complete cycle: rows whose own
`inner_checkpoint` already said `outer-published:…` — built, pushed, PR open and
mergeable, CI green — were recorded as `failed` carrying the PREVIOUS round's
REQUEST_CHANGES verdict, and each cost roughly a two-hour relaunch cycle to re-reach
the same point.

The mechanism: `buildSubstrateWorkflowFire` (trident/inner-loop.ts) races the
launcher turn's settle against a budget and resolves `{status:'failed'}` on timeout.
Cancelling the LAUNCHER does not cancel the workflow it fired — that runs detached —
so "the launcher never settled" never implied "the workflow never started". The
orchestrator nonetheless terminalized unconditionally.

Fixed in four layers, positive evidence only — a throwing, blind or failed probe
changes nothing, and with no evidence the `failed` path stays byte-identical:

- `trident/fire-evidence.ts` plus the orchestrator's `gather_fire_evidence` seam,
  consulted only when the fire fails with exactly the settle-timeout error. The
  cheapest evidence is the run's OWN row read twice: any workflow-owned column moved
  since the fire → `launched`; else an `outer-published:<sha>:0:<round>` checkpoint
  WITH `remaining` ZERO → `published`;
  a live delta OUTRANKS the published checkpoint, because a prior round's published
  row can sit under a live current round. `launched` HOLDS the lane non-terminal —
  a mirror of the `fired` return minus the settle stamp, stamped
  `fire-unobserved-launch` — and the stall guard and run-evidence watchdog own
  liveness from there. `published` terminalizes honestly: `failed` with a
  failure_reason saying the work was already built and published, review not run,
  and the verdict normalizes to REVIEW_NOT_RUN rather than replaying a stale
  REQUEST_CHANGES. `remaining` is a PREDICATE, not decoration: a published
  checkpoint whose `remaining` is non-zero is a governed round pushed with tasks
  still unbuilt, so it classifies as NO evidence and takes the ordinary
  recoverable `failed` — otherwise an unfinished card would be told "the work is
  already published, do not rebuild".
- `trident/fire-evidence-probes.ts`: the production gatherer — fresh row re-read
  first (no filesystem), then the linked worktree holding the run's branch under a
  lock naming a live pid, checked with signal-0 plus, WHEN `/proc/<pid>/stat` can be
  read, a starttime comparison that settles pid recycling. That refinement is
  best-effort by design: where /proc is unreadable or unparsable the signal-0 answer
  stands rather than a mismatch we did not measure, so the honest claim is
  "recycling is settled when /proc can be read", not "a recycled pid can never read
  as live". An `outer-published:…` checkpoint does NOT short-circuit the worktree
  probe: every re-fired round carries the previous round's published checkpoint, so
  the worktrees are asked anyway and a LIVE holder outranks it. Wired
  unconditionally at the composition root beside the run-evidence gatherer.
  The row is re-read AFTER that worktree probe as well as before it. The probe may
  take the whole 15 s host bound, and `observed` is not a report — the caller
  spreads it over the pinned row and saves it — so a checkpoint landing inside the
  probe window would have been overwritten by the gate that exists to protect the
  lane. A row that moved during the probe is itself launch evidence.
- The hold SURVIVES A RESTART. Hold ownership at the fire site is the in-memory
  `fired` set, which a restart loses by design — after which the default
  `redispatch` orphan policy would clear the slot and fire a second workflow over a
  possibly-live one. Orphan recovery now consults the same branch-holder probe
  (orchestrator option `probe_branch_holder`, wired to `defaultBranchHolderProbe`)
  and WAITS instead of redispatching while a live lock holds the run's branch. The
  90-min no-advance reaper and the 2 h ceiling, both evaluated earlier in `step()`,
  still bound that wait.
- The held row is written from what the gatherer READ, not from the pre-fire
  snapshot. `saveIfActive` assigns `inner_checkpoint`/`inner_verdict` plainly, so
  saving the pinned row back would erase the detached workflow's own progress — the
  very delta that proved the lane was live. The evidence carries the fresh
  workflow-owned columns (`observed`) and the orchestrator spreads them over the
  pinned run — together with the PHASE that carried checkpoint implies.
  `checkpoint.sh` derives `phase` from `inner_checkpoint` at the inner workflow's
  write choke point, but `saveIfActive` assigns `phase` plainly and derives
  nothing, so carrying the checkpoint while restoring the pinned phase saved an
  incoherent row: `argus` reverted to `forge-init` while `inner_checkpoint` still
  said `forge-done`. The tick applies the canonical `phaseForCheckpoint` table; a
  checkpoint that implies nothing leaves the phase exactly as it found it.
  Detection is deliberately wider than carry-forward: `inner_checkpoint_head` and
  `inner_result` prove a launch but have no column in that save, and they stay in
  the set because blinding the detection to match the save would be the worse
  trade. Carrying the fresh columns forward NARROWS that clobber window; it does
  not close it, because the gatherer's last read and the store's write are two
  statements and the detached workflow writes between them. So `saveIfActive`
  gained an OPTIONAL compare-and-swap: a caller may pass the two workflow-owned
  values it actually read, and the UPDATE writes each of them only while the
  stored value still equals what was read, keeping the workflow's newer value
  otherwise. The step carries that token through `AdvanceOutcome`; a caller that
  loses the CAS still commits every other column, so no save is dropped, and
  every caller that passes nothing behaves exactly as before. The held row also carries `workflow_run_id: null` rather than a minted
  or inherited generation: this lane has no confirmed launcher, and a stale
  generation would let the liveness probe latch a live lane as crashed.
- Dispatch refuses on branch LIVENESS, not only branch shape
  (`trident/board-dispatch.ts`, new `branch_live` refusal): a non-terminal
  same-branch run row, or a branch-holding worktree under a live lock pid, refuses
  the dispatch by NAMING the holder — creating no run and never advising deleting
  the branch. The wrong-base guard stops being the accidental last line of defence.
  It refuses AFTER the `already_landed` probe: both gates refuse and neither
  dispatches, so the only thing at stake is which sentence the operator reads, and
  "already merged as #N — verify the card" is the more actionable one for work that
  has shipped. And the refusal QUEUES the card rather than dropping it: it upserts
  a dispatch hold (kind `path` — migration 0139 pins that column's CHECK, and a
  held branch is the same "a live run owns a resource this dispatch needs" the kind
  already records) and logs `dispatch_branch_live`. Without that row a first-ever
  dispatch onto a live branch vanished with no run, no queue entry and no log,
  while the path-claim gate refusing on the same fact had always queued. The
  refusal SAYS it is queued and carries a `hold` field, like the other two
  queueing refusals — it previously said "Nothing was dispatched … Re-dispatch
  only once nothing live holds the branch" while the same block queued the card,
  and returned no `hold` at all, so every structured consumer read a queued card
  as dropped. WHEN IT SAYS NOTHING WAS QUEUED, NOTHING IS WRITTEN: behind the
  card's own live linked run the refusal writes no hold row and returns no `hold`
  field. Saying otherwise while still upserting was not merely inconsistent — the
  sweep drops such a row only while that run is STILL live at sweep time, so the
  moment it went `stopped`/`failed` (or board-reconcile detached it) the survivor
  re-fired a card that had been stopped on purpose.
- The terminal-build wake (`gateway/proactive/terminal-build-wake.ts`) stops
  inviting a relaunch for this failure shape: when the failure_reason carries the
  settle-timeout error or the published marker, instruction 2 becomes
  resolve-the-branch-holder-first (worktree lock and live pid, the run row's
  `inner_checkpoint`, the PR state; a published reason steers to a REVIEW round,
  never a rebuild). Every other failure_reason renders byte-identically, pinned by
  asserting the original instruction survives verbatim. The published branch names
  the recovery that actually EXISTS: a `bound_pr` dispatch
  (`work_board_dispatch_build`), which `orchestrator.ts` answers through
  `executeBoundReview` before base resolution and before the build workflow — it
  reviews the published head and never builds. It had briefly said
  `work_board_start` resumes such a head into a review round; that was false and
  is now stated as such in the prompt. `inner-workflow.mjs`'s
  `resumeOnUnchangedHead` does resume an `outer-published` head as mode `review`,
  but only when a checkpoint reaches it, and no dispatch entry point passes one:
  `store.create` writes `inner_checkpoint: null` unconditionally (pinned in
  `trident/store.test.ts`), so `orchestrator.ts`'s `resume_checkpoint` is null and
  a fresh `work_board_start` REBUILDS — the ~2 h this card exists to save.

The owner-facing copy moved with it. `interpretFailure` (`trident/delivery.ts`) now
matches the published marker explicitly instead of falling to the generic tail,
which offered "Reply to retry the build" one line under a summary saying the work was
already done; it says check the PR and send it for review, and not to rebuild. The
dispatch-hold sweep (`trident/dispatch-holds.ts`) treats the new `branch_live`
refusal as TRANSIENT — the hold stays queued for the next sweep — because deleting it
would silently drop a queued card that nothing re-dispatches, and it logs each
re-refusal with the hold's age, since a hold that keeps re-refusing is the signal
that the "live" holder is a stale lock nothing will ever release. That sweep also
DRAINS ON THE TICK'S OWN CADENCE, not only on a terminal run: a `branch_live` hold
created for a worktree-only holder has `held_on_run_id` null — its holder is a bare
pid, and a pid exiting fires no terminal observer — so on a quiet instance the card
queued indefinitely. `TridentTickLoop.drain_dispatch_holds` calls the same sweep once
per tick body, failure-contained exactly like the as-built catch-up, sharing the
tick's single-flight and cadence rather than adding a timer.

And a finished, pushed build is no longer ANNOUNCED as a failure. It is recorded under
phase `failed` because there is no other terminal phase for "not merged", but
`interpretFailure` gives it its own class and `composeTerminalDelivery` its own arm —
the same carve-out shape the infra-block deferral already had — so the owner reads
"built and pushed; the review never ran" under a package glyph instead of ❌ over
words saying the work finished. Every other failure class keeps the ❌ line
byte-identical.

What still holds, asserted in both directions: a settle timeout with NO positive
evidence records `failed` exactly as before, byte-identical when the seam is
unwired; `DEFAULT_SETTLE_TIMEOUT_MS` is untouched — the defect was the inference,
not the threshold — and the detached workflow is never cancelled.

WHAT THIS DOES NOT FIX, measured. The gate runs at the instant the fire promise
resolves, i.e. at the settle budget. In the flagship incident the workflow had not
yet cut its worktree at that moment (it did so ~5 min later), and inside the settle
window the row cannot have moved either, because the earliest workflow-owned write is
at `forge-done`. So that exact run would still record `failed` — what changes for it
is everything downstream: the wake no longer invites a relaunch, dispatch refuses on
branch liveness once the worktree does appear, and orphan recovery will not fire a
second lane over it. The two evidence sources the card also lists — a workflow run id
attributable to the run, and consumed brief `.part` files — are NOT implemented: the
production persistent-REPL adapter emits no `tool_call` events (see
`runtime/adapters/claude-code/persistent/hooks/activity-tap.ts`, which exists
precisely because the event stream carries nothing but the finished reply), and the
`.part` files are written by the launcher BEFORE the fire, so their existence proves
nothing about the workflow. Closing that last window needs an attributable launch
receipt from the substrate, which is a separate change.

### Round 6 (Argus round 5) — the probe stops trusting the first entry, and the queue stops over-promising

Four repairs, all inside the seams above; no new module, no new column, no new phase.

The branch-holder probe (`trident/fire-evidence-probes.ts`) now examines EVERY
same-branch worktree entry rather than the first one it finds, preferring any live
holder. `git worktree add --force --force` permits two linked trees on one branch, and
a stale entry listed ahead of the live one made the probe answer `pid_live: false`
while a lane was really building — a false negative in precisely the direction the
probe exists to prevent. The per-entry work (lock pid, recycled-pid starttime check,
mtime) is unchanged; it simply runs per candidate now.

The `branch_live` refusal says only what is true. It promised "this card is QUEUED and
dispatches automatically" in two cases where nothing would: a caller that wired no hold
store persists nothing at all, and a card that already has a LIVE LINKED RUN has its
hold deleted by the sweep on the very next pass (that run owns the card). The refusal
now picks its closing sentence from those two facts, and the structured `hold` field is
present only when a hold store actually took the row. The dispatch tests wire a real
`DispatchHoldStore` so the queued assertions are made against the shape production
actually uses, with the hold-less caller pinned separately.

The per-tick hold drain has a floor (`DISPATCH_HOLD_DRAIN_MIN_INTERVAL_MS`, 90 s,
overridable for tests). The tick is not a 90 s metronome — the change watcher wakes it
every 2 s on churn — and each queued hold costs a full re-dispatch: an uncached
`gh pr list --head` plus a 15 s-bounded branch-holder probe, serialized. The floor is
measured from the last drain that ran, so a quiet instance still drains on its first
tick and a busy one stops re-asking a question whose answer changes in minutes.

The trimmed published checkpoint actually lands now. `observed` is the caller's
compare-and-swap TOKEN and the store compares it against the STORED column, so putting
the trimmed name there lost the CAS in exactly the whitespace case the trim exists for.
`observed` carries the raw column; the orchestrator writes the trimmed `checkpoint`
onto the row it saves.

Stated rather than fixed: `phase` is derived from the observed checkpoint but written
plainly, outside the CAS that guards `inner_checkpoint`. If the detached workflow lands
a newer checkpoint inside the gap between the gatherer's re-read and the save, the row
keeps the newer checkpoint beside a phase derived from the older one. It self-heals on
the workflow's next checkpoint write, and widening the CAS over a column the TICK owns
would make a lost swap drop the lane-holding write entirely — a worse trade.

### Round 7 (Argus round 3 of this branch) — the refusal now deletes what it refuses to write

"Nothing stays queued" was enforced only against THIS refusal's own upsert. A hold row
seeded EARLIER survived it: the blocker gate upserts unconditionally, and any `path`
row written while the card had no live linked run stays behind once one appears. Either
survivor outlives the linked run, because the sweep drops a hold only while that run is
live AT SWEEP TIME — so the moment it went `stopped`/`failed` the row fell through to a
fresh dispatch and restarted a card that had been stopped on purpose. The exact hazard
this branch claims to close, arriving one row early. The `branch_live` arm now DELETES
the item's hold (idempotent, keyed on the hold table's own `(project, card)` pair)
whenever it declines to write one, so the sentence is true of the store and not just of
the call. The card is not dropped by that: its live linked run owns it, and that run's
own terminal event is what moves it next. Pinned at the transition boundary in
`board-dispatch.test.ts` (a pre-seeded hold is gone after the refusal) and end to end
over the real store and the real sweep in `dispatch-holds.test.ts` (refuse, stop the
run, sweep, no second run).

A HELD REVIEW ROUND COMES BACK AS A REVIEW. `bound_pr` is what makes a dispatch a
review of a published head rather than a build; the hold never carried it, so the sweep
re-fired a queued review as a full BUILD — opening a second PR for work already
published, and the new wake prompt steers operators to exactly that dispatch. It now
rides in the hold's `payload` (a JSON blob: no migration, and the payload is already
the "replay the dispatch as it was fired" bag), and the sweep passes it back. An
ordinary build hold still fires with `bound_pr` null.

Declined, deliberately, and recorded because it was asked for: the review wanted the
`published` arm to require a branch-holder look that actually RAN, so a failed
`git worktree list` would no longer let a row carrying the previous round's
`outer-published:…` checkpoint terminalize. It must not. A probe that cannot run is
SILENCE, and silence does not outrank a checkpoint the outer loop wrote after pushing;
downgrading that row to `failed` re-creates the SECOND SHAPE this card exists to delete
— a finished, pushed build announced as a failure, whose wake then invites a rebuild —
and the composed wiring test pins exactly that over a repo_path that does not exist.
What the distinction IS worth is the operator's sentence: `probeBranchHolderOutcome`
reports whether the look happened, and the `none` detail now says "the worktree probe
could not run" instead of claiming "no linked worktree holds the branch" about a
question nobody asked. No verdict branches on it; the dispatch-side entry is unchanged.

`WORKTREE_LOCK_PID` is anchored on a word boundary: unanchored, `stupid 45` parsed as
pid 45, and a pid the kernel happens to know reads as a LIVE holder — evidence made of
a word. Only start-of-string or a space/`(` may precede `pid`, the two shapes the
substrate writes.

The recycled-pid dispatch test is guarded on a readable `/proc`. The starttime
refinement it proves is Linux-only by construction (`/proc/<pid>/stat` field 22); where
that file cannot be read the probe keeps its signal-0 answer, the lock reads as live,
and the assertion inverts on the platform rather than on the code. Skipped there,
unchanged here.

Corrected in the docs, not the code: `drain_holds_min_interval_ms: Infinity` DISABLES
the drain (it is `> 0`, so the gate takes the due-time branch, and
`-Infinity + Infinity` is `NaN`, which every comparison rejects) — the docblock had
claimed it drains every tick, which only `NaN` and `<= 0` do. And `branch_live` reaches
409 through the catch-all `backend_error ? 500 : 409`, not an arm of its own.
