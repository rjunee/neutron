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
  since the fire → `launched`; else an `outer-published:…` checkpoint → `published`;
  a live delta OUTRANKS the published checkpoint, because a prior round's published
  row can sit under a live current round. `launched` HOLDS the lane non-terminal —
  a mirror of the `fired` return minus the settle stamp, stamped
  `fire-unobserved-launch` — and the stall guard and run-evidence watchdog own
  liveness from there. `published` terminalizes honestly: `failed` with a
  failure_reason saying the work was already built and published, review not run,
  and the verdict normalizes to REVIEW_NOT_RUN rather than replaying a stale
  REQUEST_CHANGES.
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
  trade. The held row also carries `workflow_run_id: null` rather than a minted
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
  while the path-claim gate refusing on the same fact had always queued.
- The terminal-build wake (`gateway/proactive/terminal-build-wake.ts`) stops
  inviting a relaunch for this failure shape: when the failure_reason carries the
  settle-timeout error or the published marker, instruction 2 becomes
  resolve-the-branch-holder-first (worktree lock and live pid, the run row's
  `inner_checkpoint`, the PR state; a published reason steers to a REVIEW round,
  never a rebuild). Every other failure_reason renders byte-identically, pinned by
  asserting the original instruction survives verbatim.

The owner-facing copy moved with it. `interpretFailure` (`trident/delivery.ts`) now
matches the published marker explicitly instead of falling to the generic tail,
which offered "Reply to retry the build" one line under a summary saying the work was
already done; it says check the PR and send it for review, and not to rebuild. The
dispatch-hold sweep (`trident/dispatch-holds.ts`) treats the new `branch_live`
refusal as TRANSIENT — the hold stays queued for the next sweep — because deleting it
would silently drop a queued card that nothing re-dispatches, and it logs each
re-refusal with the hold's age, since a hold that keeps re-refusing is the signal
that the "live" holder is a stale lock nothing will ever release.

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
