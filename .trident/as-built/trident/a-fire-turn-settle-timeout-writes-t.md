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
  90-min no-advance reaper, evaluated earlier in `step()`, still bounds that wait —
  and it alone does. An earlier draft of this line also claimed a 2 h ceiling; that
  was wrong (see the round-16 note below) and is struck here rather than left to
  contradict its own correction.
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

### Round 8 (Argus round 4) — the "nothing stays queued" rule now governs EVERY hold-producing gate

Round 7 fixed the `branch_live` arm and its own comment named the hole it left: "the
blocker gate twenty lines up upserts unconditionally". It does — and so does the
path-contention gate below it. Both wrote a hold row for a card whose OWN linked run was
live, and `buildDispatchHoldSweep` drops a hold only while that run is live AT SWEEP
TIME, so stopping the card on purpose and letting the declared blocker finish dispatched
a brand-new lane onto it. The branch's pinned contract — refuse, stop the run, sweep, no
second run — was true of one gate out of three.

The decision is now made ONCE, above all three gates: `queued = holds wired && the card's
linked run is not live`, plus a single `queueHold` whose two arms are "upsert" and
"delete whatever is already queued". Every gate routes through it, every refusal's prose
says which arm ran (the "it will dispatch automatically" clause is replaced when nothing
was queued), and no refusal returns a `hold` shape claiming a queue entry that does not
exist. Pinned end to end in `dispatch-holds.test.ts` for the blocker gate (refuse behind
a live run, stop that run, complete the blocker, sweep, no second run) and for the path
gate, with a must-pass sibling proving a card with no live run of its own still queues
and still carries its `blocker` hold.

THE PUBLISHED MARKER IS A TOKEN, NOT A SENTENCE. `FIRE_PUBLISHED_REASON_MARKER` was the
plain English `already built and published`, matched with `includes()` by both consumers
(`terminal-build-wake.ts`, `delivery.ts`). Any failure_reason that merely QUOTED the
phrase — `forge assertion failed: expected text already built and published to be
absent` — classified a build that published nothing as `published-unreviewed` and
suppressed its relaunch. The marker is now `[trident:published-unreviewed]`; the English
still appears in the rendered reason for the operator, only the MATCH moved.
`PUBLISHED_REASON_MAX_CHARS` grew from 200 to 231 — exactly the token's 30 chars plus its
separating space — so the budget left for the rendered checkpoint is unchanged at 61 and
no matched checkpoint is cut short. Both directions are pinned, in `delivery.test.ts` and
in the wake's own test.

THE PRODUCTION DRAIN WIRE HAS A TEST. `build-core-modules-trident-fire-evidence-wiring.test.ts`
injects its own drain callback, so it proved the tick calls what it is handed and nothing
about whether production hands anything over: deleting
`drain_dispatch_holds: () => tridentHoldSweep()` from `open/composer.ts` left the whole
suite green. That line is the ONLY trigger a worktree-only `branch_live` hold can ever
have. `open/__tests__/open-dispatch-hold-drain-wiring.test.ts` pins it source-scoped, on
the honest-coverage precedent of `open-terminal-build-wake-wiring.test.ts`.

THE LANE-HOLDING SAVE CANNOT BE THROWN OUT OF. It spread the seen row verbatim, and a
`REQUEST_CHANGES` with no findings — a shape `checkpoint.sh` can write and crash recovery
preserves — is exactly what `saveIfActive` REFUSES. The tick swallows that throw,
`subagent_run_id` stays NULL, and the next tick re-enters the launch site: a second lane
at the same branch, which is the whole thing this seam exists to prevent. The verdict is
now downgraded on that save exactly as `failedRun` does it.

Two comments were prose-stronger than the code and are corrected: the launched arm's
phase derivation reads `evidence.observed`, which is set when ANY workflow-owned column
moved — so it can carry a prior round's checkpoint, harmless because `phaseForCheckpoint`
is the same mapping the store applies; and the published arm's "can only become
REVIEW_NOT_RUN" is a property of `persistRefireReset` nulling the verdict before a
re-fire, not of `failedRun`, which passes an existing APPROVE through.

Still accepted risk, unchanged: a `branch_live` hold has no age cap, so a stale worktree
lock on a host whose `/proc` cannot be read queues a card indefinitely. The drop rule is
positive-evidence-only by design; an age cap would need a give-up path that deletes a
card's queue entry on a timer, which is the failure mode this file spent three rounds
closing. Recorded as a follow-up, not built here.

### Round 15 (Argus round 6) — the queue/no-queue decision is taken at the WRITE, not before the gates

Round 8 made "may this refusal queue the card" one rule for all three hold-producing
gates. It was still answered ONCE, at the top of `dispatchBoardBoundBuild`, off the card
read in step (2) — and then applied by gates that run after `resolveBuildRepo`, the
merge-mode probe, the landed-PR probe and the worktree holder probe. That is a
seconds-wide window of awaits. A competing dispatch that BOUND the card inside it (the
very run the branch-liveness gate then observes and refuses on) left this dispatch still
holding "the card is free", so it upserted the hold anyway. `buildDispatchHoldSweep`
drops a hold only while the linked run is live AT SWEEP TIME, so stopping that run on
purpose released the survivor onto a card someone had deliberately stopped — precisely
the hazard round 8's own comment says the delete arm exists to prevent, arriving through
the door round 8 did not close.

The rule is now a function, `queueDecision()`, that RE-READS the board and the store, and
each gate calls it at its own write — synchronously, with no `await` between the read and
the upsert-or-delete that acts on it, which is the only thing that makes the answer true
when it is used. That forced one restructure worth naming: the branch-liveness refusal
used to compose its whole message, TAIL INCLUDED, before the holder probe; the body is now
built first and the tail ("this card is QUEUED" vs "run <id> owns it") appended after the
probe, because the tail is a claim about the queue and may not be predicted across an
await. Pinned in `dispatch-holds.test.ts` under `DISPATCH TOCTOU`: a competitor binds the
card inside the holder probe (branch-liveness gate) and inside `resolveMergeMode` (path
gate); both refusals return no `hold` shape, delete even a row seeded BEFORE the race, and
after the competitor is STOPPED on purpose the sweep re-fires nothing. The must-pass
sibling — nobody racing, same late refusal — still queues and still dispatches on the next
sweep. The stub board's `get` now returns a COPY per read, like the real `WorkBoardStore`
does; handing out the live map entry aliased every read to every other one and made the
snapshot indistinguishable from a fresh look.

Residual, stated: two dispatches in DIFFERENT processes can still interleave around the
hold table itself. Closing that needs a transaction over (read card, write hold), which
the hold store does not expose; the in-process ordering is what the reported defect was.
And a hold written legitimately while the card was free, whose card is later bound and
then stopped, still re-fires — correctly: that row is a real pending dispatch request
nobody withdrew. Auto-deleting a card's holds on `stopped` was considered and rejected: it
would silently drop the hold created when an operator re-dispatches a stopped card and is
refused on branch liveness, i.e. it breaks the ordinary recovery path.

A BRANCH-LIVE HOLD STILL HAS NO TTL — ON PURPOSE — BUT IT STOPS BEING SILENT. Round 8
recorded the age cap as a follow-up and the argument against it stands: expiring the row
deletes a queued card nothing else re-dispatches, which is worse than a card that is stuck
but known. What was wrong is that a hold refused for the tenth hour logged the same warn
line as one refused for the first, so a lock nothing will ever release (third-party or
legacy, no ` start <n>` in its reason, so the recycled-pid refinement cannot fire and a
reused pid reads alive forever) was indistinguishable from a healthy wait. Past
`BRANCH_LIVE_HOLD_STALE_MS` (6 h — longer than any healthy lane, since the hang watchdog
terminalizes at 90 min) the sweep logs `dispatch_hold_branch_live_stale` at ERROR with the
age in ms. The row is untouched either way, and both arms are pinned.

ONE REGEX FOR THE PUBLISHED CHECKPOINT. `fire-evidence.ts` carried a capturing, round-
bounded copy whose docblock told a future dedupe to fold it into `run-disposition.ts` —
a module that is not on `main`. The copy that IS on main, `checkpoint-round.ts`, went
unnamed and had diverged: an unbounded round, so it read a round out of a checkpoint the
gate classified as "not published". The capturing bounded form now lives in
`checkpoint-round.ts` (the leaf, importing nothing) and `fire-evidence.ts` imports and
re-exports it, so its own consumers are unchanged.

Two findings surfaced rather than built. `inner_checkpoint_findings` is COALESCE-d, not
CAS-ed like the checkpoint and verdict beside it, so a lane holding a save composed from
an older read wins for one statement; the column is workflow-owned for DETECTION only (the
settle-timeout gate reads column MOVEMENT, never findings text) and the window closes on
the next checkpoint — the residual is now stated in the SQL itself. And the wake's
settle-timeout arm still matches plain English where the published arm matches a bracketed
token: the asymmetry is deliberate and now documented at the line — a false positive there
yields the CAUTIOUS instruction (resolve the branch holder first), which is safe advice for
any terminal build, where a false positive on the published marker suppressed a relaunch
that should have happened.

### Round 16 (Argus round 7) — the branch race is decided by the INSERT, and the drain wire is proved by calling it

Round 15 moved the queue/no-queue decision to the write. The r7 review found the half that
was still decided too early: the branch itself.

THE GATE CANNOT WIN THIS RACE ALONE. `dispatchBoardBoundBuild`'s liveness gate reads the
live rows synchronously and then AWAITS the worktree holder probe. A competing dispatch
that binds the branch inside that await is invisible to the gate, so the dispatch walked on
to `createIfClaimsAvailable` — which re-checked only `claimed_paths` — and met the live-only
unique index (migration 0138) as `UNIQUE constraint failed: code_trident_runs.project_slug,
code_trident_runs.slug`. The bare handler at the bottom of the block turned that into
`backend_error`, `work-board-surface.ts` turned that into HTTP 500, and — the part that
actually costs a card — `backend_error` queues NO hold, so the card was DROPPED rather than
parked behind the lane that beat it. The gate's own comment already named this race shape;
round 15 fixed only its queue-decision half.

So the fact is re-taken where it can no longer be raced: inside the insert's transaction.
`createIfClaimsAvailable` now asks, in one statement beside the claim scan, whether a live
row already carries this branch in this repo OR this project already has this slug live
(the two halves of the collision: the gate's question and the index's), and returns
`{ ok: false, conflict: 'branch', holding_run }`. The path conflict keeps its own
`conflict: 'path'` kind and its `path`, so the two refusals cannot be confused. Both
dispatch call sites — the gate and the admission — now render through ONE
`refuseBranchLive` helper: the same tail deciding what will re-fire the card, the same
`queueHold` arms, the same `dispatch_branch_live` log line, the same `hold` shape. A refusal
composed twice is a refusal that drifts.

A residual cross-process collision (two gateway processes, one DB file, both reads passing)
maps the raw constraint error to the same refusal rather than a 500. It is a second
mechanism for the same fact, and it is there because the cost of missing it is a dropped
card, not a slow one.

RED FIRST, AND ON THE ARM NOBODY HAD TESTED. Every existing TOCTOU test answered the holder
probe with a LIVE worktree, so the gate always refused before the write and the write-time
race never ran. The new cases answer `null`: a competitor creates a live run on the branch
inside the probe, and the dispatch must return `branch_live` naming that run, carrying a
`hold`, with a row in the queue, no second run inserted, and no card bound — then the sweep
dispatches it once the winner goes terminal. Disabling the store's branch check turns that
test red. The must-pass sibling (nobody racing) still admits and binds the card, so "never
insert" cannot pass.

THE DRAIN WIRE IS NOW PROVED BY CALLING IT. `open/__tests__/open-dispatch-hold-drain-wiring.test.ts`
was `readFileSync` plus `SRC.includes('drain_dispatch_holds: () => tridentHoldSweep()')` and
exact occurrence counts — string matching does not parse comments, so commenting the wire
out satisfied every assertion, and the counts broke on any benign refactor. It now composes
the REAL Open graph input (credentialed fixture, mock substrate, ~0.7 s — no full graph
boot) and calls the callback the product supplies, against the product's own stores: a
queued hold whose board item no longer exists is dropped by the real sweep. Commenting the
wire out turns it red. The behavioural test at the `buildCoreModules` boundary still covers
the cadence; this one covers the hand-over the cadence test injects around.

WRITTEN DOWN, NOT BUILT, each argued at the line it concerns: the liveness gate takes no
`bound_pr` exemption (a review round's own fix rounds build, on this branch, under whatever
still holds it — and the refusal queues WITH its `bound_pr`, so the sweep replays the review
the moment the holder is gone); a never-deleted `branch_live` hold lengthens every later
sweep, which is why the stale-age ERROR line is the release valve rather than a delete; a
held lane's fire-settle segment is the settle BUDGET by construction, not a measurement of
the launch; the union member that carries `hold` is the QUEUED refusal, so `'hold' in result`
— never the code, which both members admit — is the check; the orphan wait is bounded by the
90-minute no-advance reaper, which runs BEFORE it, and the comment claiming the 2 h ceiling
does too was wrong and is corrected. `STAGE_ALTERNATIVES` became a `Map`, so a prototype key
is structurally unreachable instead of unreachable-by-caller.

### Round 17 (2026-09-02) — Argus APPROVED; the round exists only to nominate the mutation the prover asked for

The review stood. Run `b5c5b38e` reached verdict APPROVE at reviewed head `d97e4bce`
(blockKind `none`, remainingTasks 0), and the run was refused afterwards by ONE gate and one
gate only: the post-APPROVE mutation prover, with "mutation proof required but the build
nominated no mutation to run" — the forge output's `mutationClaim` was null. An approved build
that cannot name a mutation is a build whose tests nobody has watched fail, so the gate is
right to refuse; the missing thing was the nomination, not the code.

ZERO SOURCE CHANGES THIS ROUND, by design. The three doc paths in this commit are the whole
diff: this file, `IMPLEMENTATION_PLAN.md`, and the byte-identical `.trident/plans` copy.
`docs/AS_BUILT.md` stays untouched (one-writer rule). The 14 recorded Argus findings are all
major/minor/nit on an approved round — notes, not work — and the salvage tag
`trident-salvage/b5c5b38e-…` (= `d56dc1d7`, +302/−688) stays unadopted: it would delete the
`trident/store.test.ts` "ARGUS r7 (BLOCKER)" regression block, and the tag preserves it anyway.

THE NOMINATION, RE-PROVEN LOCALLY BEFORE IT WAS EMITTED. At this head the find-string
`if (published !== null && Number(published[2]) === 0) {` occurs in `trident/fire-evidence.ts`
EXACTLY ONCE (checked: `occurrences=1`) — an ambiguous find is refused by `validateClaim`, and
the line moves whenever `classifyFireTimeoutRow` is edited, so uniqueness is re-checked at the
head that emits the claim rather than trusted from the last round. Replacing it with
`if (false) {` and running the two commands the prover will run gave, in this worktree:

    mutated   guard    bun test trident/fire-evidence.test.ts   exit 1   — 22 pass / 7 fail
    mutated   control  bun test trident/liveness.test.ts        exit 0   —  8 pass / 0 fail
    restored  (git checkout -- trident/fire-evidence.ts)        git status --porcelain empty
    restored  guard    bun test trident/fire-evidence.test.ts   exit 0   — 29 pass / 0 fail

That is the whole shape of a proof: the guard reddens when the behaviour is removed, the
control does not, so the guard is specific to the evidence gate this card built rather than to
the module loading at all. The mutated file never reaches a commit — it is applied, observed,
and reverted before any doc is written, and the empty porcelain above is the check that says so.

The behaviour under the knife is requirement 1's cheapest evidence: the outer-published branch
of `classifyFireTimeoutRow`, which reads the run's OWN `inner_checkpoint` and refuses to write
`failed` over a row that says `outer-published:<sha>:0:<round>`. It needs no filesystem probe,
it is the first check in the evidence list for exactly that reason, and it is the arm that
would have saved runs `74dc3e77` and `8c88c96c` — both built, pushed and CI-green when the
timeout called them failures.

### Round 18 (2026-09-02) — Argus r8: the scope check the ID-only run lookup was missing, and the marker match moved off `includes`

Round 17 nominated the mutation and the prover was satisfied; a fresh review round then found
ONE blocker and one actionable major on the same approved code. Both are fixed here, each with
a must-fail control that was watched red before it was watched green.

**BLOCKER — `queueDecision` trusted an ID-only run lookup.** `TridentRunStore.get` is keyed on
the run id ALONE. `dispatchBoardBoundBuild`'s new `queueDecision` read
`deps.store.get(linkedRunId)?.phase` and never compared the returned row's `project_slug` to
its own, so a stale or mis-copied `linked_run_id` naming ANOTHER project's live run made
`linkedLive` true for this card. The repo already has this exact defensive check in two
places — `run-progress.ts` ("a `linked_run_id` should only ever name this project's run, but
never derive across instances") and `work-wakeup-selection.ts`, which documents the reachable
cause — and BOTH of them fail safe. This one failed DESTRUCTIVE: `linkedLive` drives
`queueHold` down its `deleteByItem` arm, erasing the card's queued hold, and drives prose
telling the operator that run "owns" the card. It does not — a foreign run's terminal event
fires on a different project's board and never re-dispatches this card, so the card wedges
with nothing left to release it. The lookup is now scoped, one comparison, matching the two
existing spellings. The control is a cross-project boundary test in `board-dispatch.test.ts`:
the card's `linked_run_id` names a LIVE run in `proj-2` while a worktree lock on the card
branch is what actually refuses the dispatch; the refusal must still QUEUE, must carry its
`hold`, and must not name the foreign run. Removing the `project_slug` comparison reddens it
(39 pass / 1 fail) and nothing else.

**MAJOR — the published marker was substring-matched, so prose quoting the token collided.**
Argus r4 moved the match from the English phrase `already built and published` to the bracketed
token `[trident:published-unreviewed]`, which killed the collision anyone would hit by accident.
It did not kill the MECHANISM: both consumers still asked `reason.includes(MARKER)`, and this
repo builds itself. `delivery.ts` documents one screen below that a launcher-crash
`failure_reason` embeds substrate output VERBATIM, so a genuinely failed build whose stderr
quoted this file would have been classified `published-unreviewed` — reported as "finished and
pushed", with its rebuild advice and its wake relaunch both suppressed. The fix is the one the
finding asked for: anchor on the PRODUCER's shape. `isPublishedUnreviewedReason` (new, in
`fire-evidence.ts` beside the reason it tests) asks whether the string STARTS WITH
`PUBLISHED_REASON_HEAD` — the token sits at a fixed offset inside that head, so quoted text can
only ever appear after it. It is trim/lowercase-tolerant because `interpretFailure` lowercases
and trims before classifying, and `authoredFailureReason` only ever trims the TAIL, so the head
survives every path that reaches either consumer. `delivery.ts` and `terminal-build-wake.ts` now
both call it; `FIRE_PUBLISHED_REASON_MARKER` stays exported because the composition wiring test
asserts the rendered reason still CONTAINS it. Controls: five new negative tests across the
three suites — a mid-string token, an ENTIRE authored reason quoted inside other text, and the
plain settle-timeout reason that must stay relaunchable. Reverting the predicate to
`reason.includes(FIRE_PUBLISHED_REASON_MARKER)` reddens all five (104 pass / 5 fail).

**The minors and nits, each fixed at the line it concerns.** `store.ts`'s
`createIfClaimsAvailable` docblock no longer opens "an EMPTY claim set … always admits" — it
skips the PATH scan; the branch/slug liveness check runs for every call and can still refuse
(the paragraph three lines down already said so). The `conflict: 'branch'` refusal now says
WHICH arm collided: `liveBranchOrSlugHolder` ORs this repo's branch against this project's
slug, and the second arm ignores `repo_path`, so a card dispatched against a different repo
path collided on the slug while its branch was free and was told to go look at a branch nothing
held; the refusal and the queue behaviour are unchanged, only the diagnosis sentence. The
`refuseBranchLive` call in the OUTER catch is now itself contained — its sibling runs inside the
try, so a throwing `holds.upsert` there degrades to `backend_error`, while this one would have
escaped as a rejected promise and turned a recoverable refusal into an unhandled failure at the
surface. `fire-evidence-probes.ts` documents at the comparison site that `fresh_worktree` uses
MTIME where the card says creation time, that `birthtime` is 0 on the filesystem this runs on,
and that the substitution can only OVER-report — which is the safe direction, because this arm
returns `launched` (holds the lane, bounded by the 90-minute reaper) rather than terminalizing.
`orchestrator.ts`'s r6 "nit" correction was itself wrong and is corrected again: `overCeiling`
is computed inside the hang-watchdog block (1b), BEFORE orphan recovery (2), not after; the
substantive point — only ONE bound is worth citing, because a run that reaches the 2 h ceiling
has already reached the 90-minute reaper on the same clock — survives. `delivery.ts` records
why `published-unreviewed` is spelled as a `FailureClass` there and not in the
`trident/run-disposition.ts` the card names: that module does not exist on this branch, a
sibling card introduces it, and creating an empty one to hold a single union member would have
made two cards conflict over a file neither had landed. The cross-reference says to fold it in
when the sibling lands. And the stray blank line the r6 round left in `tick.ts`'s import block
is gone.

**Not done, deliberately.** The mutation nomination is unchanged: no round-18 edit touched
`classifyFireTimeoutRow`, the find-string still occurs exactly once in `trident/fire-evidence.ts`
(re-checked at this head, `occurrences=1`), and the guard/control pair still reddens and stays
green respectively. The r8 findings about the worktree-lock reason with no ` start <n>` and about
`branch_live` holds paying full dispatch cost every drain are left as written down: both are
deliberate trades already argued in-file, and both would be closed by changing a bound rather
than a defect.

### Round 19 (2026-09-02) — the confirmed r9 blocker: a fallible hold write may not become a rejected promise

**The blocker.** `refuseBranchLive`'s hold write sat outside every `try` at the branch-liveness
gate (the probe's own `try` closes before it, and the admission `try` opens after it), and so did
the blocker gate's `queueHold`. Both arms of `queueHold` are DB writes — `holds.upsert` and
`holds.deleteByItem` — so a locked SQLite file turned a typed, recoverable refusal into a
REJECTED PROMISE out of `dispatchBoardBoundBuild`, which both callers (`trident/code-command.ts`,
`open/composer.ts`) await with no local `try`. Only the sweep contained its own per-hold throws.

**The fix is one containment, not three.** `queueHold` now catches and RETURNS a `QueueOutcome`
(`queued`, `error`) instead of throwing, so every gate that writes a hold is covered by
construction rather than by remembering to wrap the next one. What degrades is only the part the
failed write actually invalidates: the refusal keeps its typed code — the card really is blocked,
the branch really is held, and that fact is what the caller acts on — while the queue claim is
retracted in BOTH the prose (a NOTE naming the store's own error and telling the operator to
re-dispatch by hand, because nothing will re-fire the card now) and the shape (no `hold` field,
which is a claim a row exists). Choosing that over `backend_error` is deliberate: a 500 loses the
reason the dispatch was refused, and the reason is the actionable half. The r8 wrapper in the
outer catch stays as belt and braces for the rest of `refuseBranchLive` — its `queueDecision`
re-read and its log line — with its comment corrected to say so.

Pinned by two tests over the REAL `DispatchHoldStore` with a throwing `upsert`, one per unwrapped
gate: the call resolves to `branch_live` / `held`, names `database is locked`, says nothing could
be QUEUED, and carries no `hold`. Without the containment both tests fail by rejection.

**Also closed (r9 minor).** `buildDispatchHoldSweep` read `store.get(item.linked_run_id)` with no
project comparison — the same unscoped lookup the r8 fix closed in `queueDecision`, but with the
DESTRUCTIVE consequence: a foreign project's live run read as this card's driver deletes the hold,
and that run terminalizes on another board and never re-dispatches this card, so the card is gone
with nothing left to revive it. Scoped to the hold's own project; the test seeds exactly that
shape and asserts the card DISPATCHES (2 runs, card attached) rather than being silently dropped,
and it fails against the unscoped read.

**Doc.** The orphan-wait bound is stated once, correctly: the 90-minute no-advance reaper, and it
alone. The earlier line claiming the 2 h ceiling also bounds it contradicted its own correction
lower in this file and is struck.

**Not done, deliberately.** The r9 major about the settle-timeout gather being a single
synchronous pass at the timeout instant — while the card's own measurements put first evidence
63-277 s later — is left for a follow-up round, as BOTH reviewers who raised it recommended.
Closing it means holding the row open across ticks and re-asking, and the negative control
(`6948da2d`, a fire that never launched) must still terminalize; that is a change to the
orchestrator's step state machine, not a wrap, and it does not belong in the same round as a
one-function containment fix on an otherwise approved diff.

**The mutation nomination CHANGES this round**, to the behaviour this round is about:
`trident/board-dispatch.ts`, the `queueHold` catch's `return { queued: false, error: … }` replaced
by `throw err` — measured at this head, guard `bun test trident/board-dispatch.test.ts` 40 pass /
2 fail mutated against 40 pass / 0 fail clean, control `bun test trident/liveness.test.ts` 8 pass
/ 0 fail mutated. The find-string occurs exactly once.

### Round 20 (2026-09-02) — Argus r10: a FAILED delete may not be reported as "nothing was queued"

**The blocker.** `queueHold` has two arms — upsert the hold, or DELETE whatever an earlier
dispatch already queued — and both were reported with ONE sentence: "nothing could be QUEUED …
so this card will NOT re-dispatch on its own; re-dispatch it yourself". For the delete arm that
sentence is false in the dangerous direction. The row the arm exists to remove is still there,
and it is exactly the survivor `buildDispatchHoldSweep` re-fires once the card's linked run
terminalizes — so the card MAY move on its own, while the operator has just been told to move it
by hand. Two lanes on one card, which is the harm this whole branch exists to prevent.

**The fix.** `QueueOutcome` now carries `attempted: 'upsert' | 'delete'`, set before either write,
and `queueFailureClause` branches on it. The delete-failure clause says the STALE hold could not
be removed, that it may still exist and may re-dispatch the card on its own, and asks for it to be
CLEARED — not for a manual re-dispatch. The upsert clause is unchanged. No arm claims a `hold`
shape it did not write.

**The missing intersection test, added.** The two existing throw tests both make `upsert` throw;
neither reaches the delete arm, because that arm only runs when the card has a live linked run.
The new test seeds a hold, gives the card a live linked run (so the refusal takes the delete arm),
makes `deleteByItem` throw, and asserts: the refusal is still the typed `branch_live`, the seeded
row is STILL PRESENT, the prose says "could not be REMOVED" / "may still exist", and the two
sentences that would produce a double dispatch are ABSENT.

**Also closed this round, all single-reviewer non-blocking findings.**

- The composed drain wiring test asserted only `expect(drained).toBe(1)`. The path is pinned in
  two halves on purpose, and the comment now says so: this half proves the composed tick CALLS the
  drain it was handed, and `open/__tests__/open-dispatch-hold-drain-wiring.test.ts` proves the
  drain the PRODUCTION composer built moves real hold state. Joining them would mean building the
  sweep inside the composition test, which proves nothing about production.
- That Open-side test narrowed the composition's cleanups to `() => void` and invoked them
  un-awaited before `db.close()` and `rmSync`. The contract type permits `Promise<void>`; the
  array is widened to match and the teardown awaits each cleanup.
- The `observed` carry-forward on the live-holder-over-published arm was mutation-insensitive.
  The "a live branch holder OUTRANKS an outer-published checkpoint" test now asserts
  `evidence.observed?.inner_checkpoint` is the published marker — verified to fail when the
  carry-forward is dropped.
- `saveIfActive`'s NULL-safe `inner_checkpoint IS ?` half was pinned by nothing. A new store test
  saves a FIRST checkpoint over a NULL both the row and the caller saw; under `=` the CAS reads as
  lost and the write is dropped — verified red against that mutation.

**Not done, deliberately, and unchanged from round 19.** The one-shot gather at the timeout
instant (the row is classified once, at t+0, while the card's own measurements put first evidence
63-86 s later) still stands as a follow-up. Both reviewers who raised it recommended that, it is
not a regression against base, and closing it means holding the row open across ticks and
re-asking while the negative control `6948da2d` must still terminalize — a change to the step
state machine, not a wrap.

**The mutation nomination CHANGES this round**, to the behaviour this round is about:
`trident/board-dispatch.ts`, `if (outcome.attempted === 'delete') {` replaced by `if (false) {`,
which routes a failed DELETE back through the upsert sentence. Guard
`bun test trident/board-dispatch.test.ts`, control `bun test trident/liveness.test.ts`. The
find-string occurs exactly once.

### Round 21 (2026-09-02) — Argus r10 review 2: the race is classified by the STORE, not by the error string

**Blocker 1.** `dispatchBoardBoundBuild`'s outer catch mapped exactly one spelling of the
two-process branch race — `UNIQUE constraint failed: code_trident_runs.(project_slug|slug)` — to
the `branch_live` refusal and its hold. Two connections on one DB file also collide as
`BusyRetryExhaustedError: SQLITE_BUSY: exhausted 15 retries` (codex's two-`ProjectDb` repro
against `ProjectDb`'s deferred BEGIN), which that regex does not and should not match, so the
loser returned `backend_error` → HTTP 500 with NOTHING queued. The in-code comment already called
two gateway processes on one DB file "the SAME fact" deserving "the same refusal and the same
hold"; the BUSY manifestation of that fact did not get it.

**The fix.** The error text stopped being the classifier. On ANY failure inside the admission
block the catch asks the store who holds this card NOW — a non-terminal row on this repo carrying
the branch, or one this project already has under this slug (the unique index's other arm) — and
when one is visible it returns the shared `refuseBranchLive`, naming the winner, so the hold is
bound to the run whose terminal event releases it. Positive evidence only, unchanged: no visible
holder (including the common BUSY case where the winner has not committed yet) is still a genuine
`backend_error`. A new `createdRunId` guard skips the whole re-read once the insert has WON, so a
failure in `board.attachRun` / `holds.deleteByItem` can never be re-diagnosed as a competitor and
park a card behind its own run.

**Controls (`trident/board-dispatch.test.ts`).** A REAL second `ProjectDb` on the same file lands
the competitor's row while this dispatch's write fails BUSY: the refusal is `branch_live`, names
the winner, says `SQLITE_BUSY`, and a real hold row exists bound to the holder — red first
(46 pass / 1 fail) with the holder arm disabled. Two siblings must stay green: BUSY with no holder
anywhere is `backend_error` and queues nothing, and a throw AFTER the run was created is
`backend_error` with the run intact and no hold.

**Blocker 2, documentation.** The operational plan's resume state was still the round-18 one and
nominated `trident/fire-evidence.ts` — the target round 20 superseded — so a prover following the
plan would run the wrong guard/control contract. Both copies (`IMPLEMENTATION_PLAN.md` and
`.trident/plans/trident/…`) now carry the round-21 state and the round-20 nomination, re-verified
at this head: `if (outcome.attempted === 'delete') {` occurs exactly once in `board-dispatch.ts`.

**Also closed this round.**

- The published round is bounded AT THE WRITER. `OUTER_PUBLISHED_CHECKPOINT` accepts `\d{1,9}`
  while the orchestrator interpolated `result.round` — substrate JSON, unbounded — verbatim. The
  old docblock's safety argument ("both consumers fall back to the ordinary recoverable answer")
  predates this branch: under the settle-timeout gate, "not published" now feeds terminalization
  of a run that DID publish. `checkpointRoundField` clamps to `[0, 999999999]` (and reads NaN /
  ±Infinity / negatives as 0), the write site calls it, and the boundary tests pin that a marker
  built from any of those inputs still parses as published.
- `queueDecision`'s two DB READS are contained — the same escape class the r9 fix closed for the
  hold WRITE, at the two gates that call it outside every try. A throwing `board.get` falls back
  to the opening snapshot; a throwing `store.get` counts the linked run as LIVE, which takes
  `queueHold`'s delete arm, so a failed read can never CREATE a hold behind a card that may
  already have an owner.
- `probeBranchHolder` wraps its `probe_pid_alive` call, so the "returns null when we could not
  look" and "neither step may throw" docblocks are true for an injected seam as well as for
  `defaultProbePidAlive`. A throw reads as `unknown` — no evidence — which the suite already pins.
- `saveIfActive`'s `round` bind honours the SAME compare-and-swap as the checkpoint it is derived
  from: a lost CAS contributes 0 instead of advancing the column from a checkpoint the statement
  declined to store. Red-first control plus the must-pass sibling (a WON CAS still advances).

**Not done, deliberately, and unchanged.** The one-shot gather at the timeout instant stays a
tracked follow-up for the reasons round 20 recorded. So does the composed tick/drain split: the
call-count half proves the composed tick calls the drain it was handed, and
`open/__tests__/open-dispatch-hold-drain-wiring.test.ts` proves the PRODUCTION-composed drain moves
real hold state; joining them means building the sweep inside the composition test, which proves
nothing about production. Both approving reviewers accepted that argument as written.

**The mutation nomination is UNCHANGED from round 20** — `trident/board-dispatch.ts`,
`if (outcome.attempted === 'delete') {` → `if (false) {`, guard
`bun test trident/board-dispatch.test.ts`, control `bun test trident/liveness.test.ts`. This
round's edits to that file do not touch `queueFailureClause`; the find-string still occurs exactly
once.

**Workspace note for the next round.** A fresh linked worktree has no `node_modules`, so
`@neutronai/*` resolves up to the shared checkout — a different lineage — and the suite fails with
`no such column: claimed_paths` / `no such table: code_trident_dispatch_holds` at BASE as well as
at head. Run `bun install` in the worktree first; it is a workspace-setup artifact, not a defect.
