## 2026-09-12 — a deploy that kills a build in flight says so, instead of reporting a crash

Spec item: `docs/spec-items/a-deploy-must-not-kill-builds-in-flight.md` (#518, P0, cutover
milestone 2).

**#518 IS NOT DELIVERED BY THIS WORK, and the issue stays open.** The item asks that a
deploy not kill the builds in flight; every pooled and quarantined launcher is still killed
during shutdown, and criterion 1's own analysis says why nothing inside this process can
change that while the REPL lives in the gateway's cgroup (#538/#539 move it). What landed
is the PREREQUISITE: the killing is now reported honestly instead of surfacing as a bare
crash, and a death nobody established is no longer reported as a death at all. Criteria 1
and 2 are unticked; 3 and 4 are met.

### What was actually happening

A trident inner workflow is not its own process: it runs detached inside a warm `claude`
REPL the gateway owns (`cc-trident-fire-<owner>-<repo>`, composed in
`open/wiring/substrates.ts`). The spec item says a service restart "SIGTERMs that REPL",
which understates it — the gateway's own SIGTERM handler calls
`shutdownAllPersistentRepls` (`gateway/index.ts:1052`), which walks the pool and calls
`session.child.kill()` on every warm child (`pool.ts:1034`). We kill it. Three of five
recorded `trident_launcher_crashes` landed 18–28 s after a deploy's vendor checkout, and
the 08-13 deploy rolled trident's own merge: a build that lands killed the builds still
running, at the rate the pipeline succeeded.

The detectors were working. The next boot's supervision watchdog found the recorded pid
dead and reported `pid-dead → "pooled child exited"`; the external launcher-liveness probe
reported `generation <g> is dead`. Both true, both the wrong sentence — they describe a
crash, and the owner reading them went looking for a bug in his own build.

Worse, the ONE class of child certain to be hosting a live build reported nothing at all.
A child is quarantined precisely because it still hosts running workflows (the eviction
guard deferred its reaping), and `shutdownQuarantinedChildren` deleted its map entry
before killing it — which makes the `child.exited` hook `quarantineChild` installs return
early (`spawn.ts:908`). Every deploy killed those silently.

### The choice the spec item demanded, and why it is what it is

Acceptance criterion 1 offers two mechanisms: drain/defer, or the workflow survives its
launcher's restart. The architecture rules.

**Drain/defer cannot work from inside this process.** A deploy ends in
`systemctl restart`; the unit is `KillMode=control-group`, so every descendant is SIGKILLed
at `TimeoutStopSec` no matter what the polite layer decides — `gateway/index.ts:1026-1045`
already writes that down. A `hostsLiveWork` gate on the shutdown loop would report a
deferral it could not deliver, and would reopen the 632-orphan / 19 GB risk that call site
exists to close on non-systemd hosts.

**And nothing here could make a survivor useful.** `orphan-adoption.ts` is adopt-or-kill
and only ever kills — verdicts `killed|not-ours|dead|no-pid` (`:49-53`), no adopt arm — and
`spawnResume` terminates the recorded pid before resuming (`:229`). A child that survived
a restart today would be killed by the next boot.

**Both halves are milestone-1 work that lands first.** #538 puts the REPL in a herdr pane
outside this process tree and cgroup; #539 is explicitly "gating the shutdown kill" plus
the adopt verdict and a boot reconciliation pass. A drain built here would be a mechanism
#539 obsoletes, in a tree that forbids dual code paths — so the mechanism half is left to
#539 and its acceptance box is left OPEN rather than ticked against a check that does not
exist.

One fact makes the herdr half genuinely sufficient rather than merely plausible: the
detached workflow does not need the gateway to make progress. It writes its terminal result
straight to `code_trident_runs.inner_result` through its own `agent()` Bash step
(`trident/inner-loop.ts:29-35`), and the tick loop harvests the row later. So once the pane
survives and the shutdown kill is gated, the run really does continue — the orchestrator
living in the gateway does not have to be up for the build to finish.

**The reporting half is needed either way**, is independently testable, and is the
criterion the owner cares most about. That is what this change delivers.

### What was built

The one process that knows a kill was deliberate is the one pulling the trigger, and the
only moment it knows is just before. So it writes it down.

- **`runtime/adapters/claude-code/persistent/gateway-shutdown-kill.ts`** (new) owns the
  edge: ~~`reportGatewayShutdownKill` stamps a generation-scoped marker on the durable REPL
  registry row and tells the crash sink with `cause: 'gateway-shutdown'`, awaited, before
  the kill.~~ SUPERSEDED (round 4): the two halves are split by phase —
  `recordGatewayShutdownKill` writes the generation-keyed record synchronously before the
  kill, and `deliverShutdownKillReports` delivers the live report afterwards under a bound.
  `reportGatewayShutdownKill` survives only as a single-child convenience for callers
  outside the shutdown walk. `markKilledByGatewayShutdown` returns whether the marker IS ON DISK, read back
  through the same predicate the consumers use — `patchRecord` is a silent no-op for a
  session key with no row, so "the call did not throw" is not evidence anything was
  recorded.
- **`ChildCrashInfo` gains `cause: 'child-died' | 'gateway-shutdown'`** (`persistent/types.ts`),
  re-exported at the adapter boundary. The literal shape was declared in THREE places; the
  third copy (`gateway/wiring/build-llm-call-substrate.ts:391`) is why the discriminant did
  not reach its consumer on the first attempt, and it now imports the type instead.
- **Both shutdown sites report.** `shutdownAllPersistentRepls` (`pool.ts`) resolves the
  owning options through `supervisedBySessionKey` — the same map the watchdog resolves a
  crash sink through, populated by the production adapter for every REPL whose instance home
  resolves (`adapters/claude-code/index.ts:533`) — and reports before each kill, with one
  timestamp for the whole teardown. `shutdownQuarantinedChildren` (`spawn.ts`) now reports
  too. An unregistered key writes a stderr line naming what could not be told, rather than
  dying silently.
- **The next boot reads the marker.** `ReplWedgeProbe` gains `shutdownObserved`, carrying
  the four-valued observation rather than a yes/no; `detectReplWedged`'s dead-child branch
  returns `pid-dead-gateway-shutdown` with a detail that names the deploy when the
  observation is `alive-and-killed`, and `pid-dead-cause-undetermined` when the shutdown
  reached the child but did not establish the kill. The operator alert texts
  route through one `wedgeSymptom` helper so the two bodies cannot drift.
- **The pull half too.** `probeLauncherGenerationAlive` answers
  `'killed-by-gateway-shutdown'` — but only AFTER `process.kill(pid, 0)` has independently
  said dead. The marker explains a death; it may never create one.
- **Composition lives in one place per half.** `trident/deploy-kill-reason.ts` authors the
  reason and `DEPLOY_RESTART_KILL_MARKER`; `delivery.ts` classifies on that constant into a
  new `deploy-restart` `FailureClass`, so the owner's announce says "killed by a deploy or
  restart of this instance, not by anything wrong with the work" instead of falling through
  to the generic arm. The reason deliberately avoids `crash`, `stalled`, `exhausted`,
  `conflict` and a bare `git ` — every token `delivery.ts` routes on.
- **`open/wiring/trident-child-crash-sink.ts`** (new) holds the sink that was an inline
  closure in the substrate literal. Extracted for one reason: while it was inline the only
  way to test it was to retype its composition in the test, which asserts that a copy of
  the code does what the copy does. The wiring passes this function; the test calls this
  function.

### Attribution is claimed only where it was earned

Two corrections found in review, both the same defect as the original one and both pointing
the other way — an attribution not entitled to its confidence.

**A child that was already dead is not a deploy kill.** `kill()` is idempotent after exit
(`pty-host.ts:46`), so teardown "kills" a child that died of a genuine fault moments earlier
exactly as readily as a live one. The first cut reported before sampling anything, so that
fault was attributed to the deploy — this PR's own thesis running backwards, and the worse
direction of it: a bare crash for a deploy sends the owner after a bug that is not there, but
a deploy for a real fault stops him looking at a bug that is. Liveness is now sampled first
(`sampleLivenessBeforeShutdownKill`) and `'gateway-shutdown'` is claimed only for a child
observed alive. Anything else — already gone, or liveness unreadable — is `cause: 'unknown'`,
a third member added precisely so `deploy` and `cannot tell` never share a branch. It writes
no marker (an excuse on disk for a death we did not cause). ~~and leaves
`child_crash_notified_at` OPEN, so the next boot still reports the fault honestly.~~
CORRECTED (round 7): it leaves the edge open only until the report is DELIVERED. A delivered
undetermined report closes the edge like any other, because the edge records that a report
happened, not what it said — see "The edge is keyed on delivery, never on the verdict" below.

The residue is stated rather than papered over: `hasExited()` is a sample, so a child exiting
between the sample and the `kill()` still lands in the deploy bucket. That window is a
scheduler tick and it is irreducible with what a `PtyChild` exposes — `wasKilledByUs` answers
*who* signalled, not *when* it died, and our own `kill()` settles `exited` too, so no post-kill
read separates them. The remaining error is in the unsafe direction for microseconds, narrowed
from the whole teardown; it is named in the module header because a bounded misattribution
somebody can find beats an unbounded one nobody knows about.

**The marker was generation-scoped; the row it lives in was not.** One teardown reaches two
generations on one session key — the pooled child, and a quarantined child that held the key
before a fresh spawn took it over — and they share one registry row (`pool.ts:1008`, then
`pool.ts:1094`). The later write replaced the earlier one, so the row named one generation
beside a marker naming the other: attribution failed AND `child_crash_notified_at` stayed set,
disabling the next boot's backstop in exactly the case it exists for. `markKilledByGatewayShutdown`
now refuses a generation the row does not currently name — free, because both consumers match
on the row's CURRENT `child_generation`, so such a marker was never readable — and says so on
stderr rather than failing quietly.

The multi-generation test asserted only the emitted callbacks while reading as though it
covered the durable half; it now asserts the final registry row.

### Two correct fixes, and the hole between them

The round-2 row-scoping refusal and the round-4 best-effort delivery phase were each right,
and their interaction was not. A QUARANTINED child's generation is by definition not the
session-keyed row's current one — a replacement spawned over it — so
`markKilledByGatewayShutdown` REFUSED its marker, working exactly as designed, while
`shutdownQuarantinedChildren` still queued its report. If that report failed, timed out, or
was skipped by the phase budget, delivery said the next boot would recover it from a marker
that did not exist. A child is quarantined *because* it still hosts running workflows, so that
was the death likeliest to matter and the one left with no record at all.

**Measured before choosing, because the options were not equally reachable.**

*Marking at quarantine time is unsound, not merely awkward.* `sweepQuarantinedChildren`
terminates a quarantined child on the ROUTINE drain once its hosted work finishes
(`spawn.ts:928-933`). A marker written at quarantine time would attribute that ordinary reap
to a deploy, so the option needs the marker to mean something weaker than it says. Rejected on
correctness, not cost.

*Narrowing the claim* was honest but re-opened the silence for precisely these children.

*The durable per-generation record* is the shape the delivery claim already assumed, and it
measured far smaller than "a schema change and its migration" implies: the registry is a JSON
file (`atomicWriteFileSync`), not a table, so there is no migration; `isMinimalRecord` checks
four fields and tolerates unknown ones, so old and new builds interoperate in both directions
during a rolling restart; and it touched 8 production references.

**It removes machinery rather than adding it.** `killed_by_gateway_shutdown` is now a bounded
list of `{generation, at}`, and both readers look up by generation —
`wasKilledByGatewayShutdown` asks about the row's current child (the watchdog's question) and
`probeLauncherGenerationAlive` asks about an arbitrary one (trident's question, and the one a
quarantined child needs). Because an entry names its own generation, a stale entry cannot be
read as describing the current child — so the round-2 refusal guard and `spawn.ts`'s
clear-on-respawn are both DELETED, and the invariant they defended is a property of the shape
instead of a rule enforced in two places. The clear-on-respawn had to go regardless: the entry
must outlive the generation it describes, which is the whole reason it exists.

**And it closes a hole older than this item.** `probeLauncherGenerationAlive` matched only
`record.child_generation` (`supervision.ts:1059`), which a replacement spawn overwrites
(`spawn.ts:735`) — so a quarantined generation has never been locatable in the registry, and
its build waited out the 90-minute reaper with no reason ever delivered. This change did not
remove that recoverability; it added a claim that assumed it, and now supplies it.

The entry scan looks up a generation nobody recorded and still answers `unknown` — absence is
never death.

~~It is positive evidence, not absence read as death: a record that WE terminated that
generation, written by the process that did it, before it did it.~~ CORRECTED (round 6): that
sentence was the defect. "Before it did it" is precisely why the record is NOT proof — the kill
can throw, or the process can die between the write and the kill. The record attributes a
death; the process table establishes one. The scan therefore confirms against the pid the entry
carries and uses the record only to explain a death it has already observed, which is what
makes "the marker never manufactures a death" true rather than aspirational.

**The delivery claim is now conditional.** `PendingShutdownKillReport` carries
`durablyRecorded`, and the operator line for an undelivered report says either "the next boot
reports it from the durable record" or "and NOTHING durable records this death — it is lost".
A promise that quietly does not apply to a subset is worse than a narrower promise.

### The premise that was missing, and the three defects that shared it

Three review rounds found three defects in this module, and each fix introduced the next:
round 1 claimed attribution for children that were already dead; round 2 wrote the "reported"
tombstone before the report; round 3 put the report on the kill path. They share a root. The
reporting path was bolted onto a shutdown sequence whose constraint was never written down.

It is written down now, at the top of `gateway-shutdown-kill.ts`:

> This code runs inside a shutdown with a bounded external deadline that this process does
> not control, and it may get no further turn. Everything in it is either durable-and-cheap
> or bounded-and-optional, and the two are separated by phase.

Concretely: systemd's `TimeoutStopSec` is 30 s and the cgroup SIGKILL fires at the deadline
whatever we are mid-way through (`gateway/index.ts:1026-1045`); the database closes a few
statements after we return. So the registry marker — local, synchronous, durable — runs for
every child first, and the live `onChildCrash` report — a call into a sink this module does
not own — is attempted only after every child is marked and killed, under a bound.

**What the third defect actually cost.** `shutdownAllPersistentRepls` awaited the
unrestricted sink promise between one child's kill and the next child's marker. Give the
first pooled session a sink that never settles and the walk never reaches the second child at
all: no marker, no kill. Production then SIGKILLs the cgroup 30 s later, and every remaining
child is reported on the next boot as a bare crash — this change's own purpose, defeated
inside this change, and worse than the original defect because one hung sink took out every
child behind it rather than one.

**The shape of the fix.** `recordGatewayShutdownKill` is synchronous: it samples liveness,
writes the marker, and RETURNS the live report that is now owed.
`deliverShutdownKillReports` runs once, at the end, bounded twice — at most
`SHUTDOWN_REPORT_PER_SINK_MS` per sink so one hang cannot hold the phase, and at most
`SHUTDOWN_REPORT_PHASE_BUDGET_MS` across the phase so N hangs cannot each spend the per-sink
bound out of a deadline the rest of the teardown shares. An abandoned promise keeps a
`.catch` attached so a later rejection cannot surface as an unhandled one. The phase returns
a per-outcome tally rather than `void`, because a phase that delivered nothing must be
distinguishable from one that delivered everything.

Losing a report there is survivable by construction — the next boot reads the marker and
delivers the attributed report. Losing a marker or a kill is not, which is why neither is
allowed behind a sink.

One test had to change rather than be added, and the change is the honest one: the pooled
case asserted that the report arrived *before* the kill. That was true of the old shape and
is deliberately false now. It asserts the property that replaced it — the durable marker is
already on disk when the report is attempted — and that the child is already dead by then, on
purpose.

**On the clamp, and an opt-out that turned out not to be needed.** `Math.min(perSinkMs,
remaining)` changes no count — never which reports are attempted, only how long the last one
may hold the phase — so a count-based assertion cannot discriminate it, measured rather than
assumed: a count-based version left the mutation alive. It was first pinned with an elapsed-time
assertion and a `WALL-CLOCK-BOUND-OK` opt-out, argued on the grounds that the clamp's only
observable effect IS elapsed time.

~~That opt-out stands.~~ It does not. The bounded wait is now INJECTED, so a test can hand in
one that records the budget it was asked for and resolves at once — the clamp became directly
observable and the opt-out was removed rather than justified. The gate's count went 13 → 12.
The prompt for that was not tidiness: five bound-related cases passed in their own directory and
failed inside a 206-file process, because racing a real timer against a never-settling sink
measures event-loop load rather than the bound. A deterministic assertion was available after
all, which is exactly what that gate asks anyone claiming otherwise to check.

### A tombstone is written after the thing it attests to

The third correction, and the sharpest, because it is this change's own subject turned
against it. `child_crash_notified_at` was stamped in the same patch as the attribution
marker — before the sink ran. The sink's failure is caught and discarded, so a transient
failure left the edge CLOSED with nothing reported; the next boot's watchdog skipped the
death on that field, the respawn cleared the marker, and the pull probe then answered
`unknown` for the dead generation. The owner received **no failure reason at all**. In a
change that exists because a deploy-caused death surfaced as a bare crash, that is the same
defect one step further on: it surfaced as nothing.

The reasoning was already written down one branch away. On the unattributed path the edge is
deliberately left OPEN, because closing it would silence the next boot's honest report of a
death we had just declined to claim. That argument applies identically to the attributed
path; one branch got the careful treatment and its neighbour got the optimistic one.

Only one of the two facts is knowable before the kill. The ATTRIBUTION — we are about to
terminate a child we observed alive — is knowable then and must be written then, because
afterwards this process may get no further turn. That the death was REPORTED is not knowable
until the sink commits. So they are split: `markKilledByGatewayShutdown` records the cause,
`closeCrashReportEdge` closes the edge after the await.

That ordering alone delivers retry-with-attribution, with no second state to carry it: a
throwing sink leaves the marker on disk and the edge open, so the next boot's watchdog finds
the dead pid, reads the marker, and emits `cause: 'gateway-shutdown'` with the deploy detail.
The owner learns it was a deploy, late, rather than getting a generic crash or silence. The
de-duplication the early write provided is preserved by closing the edge after success, and
the complement pins it: a sink that succeeds is not reported twice.

**The general rule, which is why this is worth the space:** anywhere a marker means *this was
reported*, the write belongs after the commit that makes it true. Written first it records an
intention as an outcome. Same class as #577's "return what is on disk, not what you wrote".

The test gap that let it through is the shape of the M8 note: the throwing-sink case asserted
that the marker EXISTS — the artifact — never that the backstop the marker is for fires. The
sequence is now driven end to end.

### The owner's copy cannot depend on a length accident

The undetermined reason first relied on `interpretFailure`'s fallback arm, which prints an
authored reason verbatim only while it stays under 200 characters. This one crossed the line,
so the owner was handed "The build did not complete." about a build whose launcher had
vanished — the silence this whole change is against. It now carries its own authored marker
and an explicit branch. The class stays honestly `'unknown'`; only the sentence is specific.

### Two things this deliberately does NOT do

**It does not attribute by correlation.** `#240` already refused to infer cause from
timestamps, and this keeps that: attribution exists only where the gateway recorded it
itself. The 08-10 23:30 and 08-11 06:04 crashes have no marker and are reported exactly as
before — the spec item says a fix that claims them fails review, and the complement tests
are what make that true rather than asserted.

**It does not widen `RunLiveness`.** The hang watchdog compares `probe === 'dead'` in eight
places and composes its own reason from its own evidence; the attributed verdict collapses
to `'dead'` at the composition seam (`gateway/composition/build-core-modules.ts`) with the
reason written down, because the 15-second liveness loop latches the run terminal long
before the 90-minute watchdog could look at it.

### The marker cannot be read as describing the wrong child — or as proving a death

> SUPERSEDED IN PART, twice, and left standing because the round order is how the design got
> here. The two paragraphs below describe the **round-2** single-slot marker. Round 5 replaced
> it with a per-generation list and DELETED both guards they name; round 6 added the
> confirmation step the read side was missing. The reconciled statement follows them.

~~That is the mutation that would make this lie in the one direction the spec item forbids —
a genuine fault credited to a deploy — so it is guarded twice. `wasKilledByGatewayShutdown`
demands the marker name the row's CURRENT `child_generation`, and `spawn.ts` drops both
fields when it writes a new generation, exactly as it already dropped
`child_crash_notified_at`. Both guards have their own red mutation.~~

~~`child_crash_notified_at` is stamped by the marker write for a concrete reason:
`crashRunningByLauncher` upserts with
`ON CONFLICT(session_key) DO UPDATE SET failure_reason = excluded.failure_reason`, and
`saveIfActive` reads that tombstone back — so a late bare "pooled child exited" from the
next boot's watchdog would have laundered the deploy attribution away.~~

**As built.** The record is a per-generation list, so an entry NAMES the generation it
describes and cannot be read as describing another — no guard, no clear-on-respawn, and the
record deliberately OUTLIVES its child because a quarantined generation has nothing else.
`child_crash_notified_at` is not written by the marker at all: it is written by
`closeCrashReportEdge` after a sink commit (round 4), which is why a failed report leaves the
edge open for the next boot. The upsert hazard that paragraph described is gone for a
different reason than it claimed — the next boot's report now carries the SAME deploy
attribution, because it reads the same record, so a second write rewrites an identical
sentence rather than laundering a bare one over it.

**And the record never proves a death.** It is written before `kill()`, and `kill()` can
throw, so an entry means "we intended to kill a child we had observed alive". The reader
confirms the death against the pid the entry carries and answers UNKNOWN when it cannot
(`supervision.ts:1123-1163`). Round 6's finding was this exact over-claim arriving on the read
side: round 3 refused to claim a deploy for a child that might already have been dead, and the
per-generation scan then claimed a death for a child that might still be alive. Same missing
question — *what does this record actually establish?*

### The root: a two-valued record for a three-valued domain

Nine findings landed on this change, and three were the same shape. The record's vocabulary was
*an entry exists* / *no entry*. The domain is **killed-by-deploy**, **undetermined**, and
**ordinary crash** — so `undetermined` shared its representation with `ordinary crash`, which is
precisely the conflation this change exists to stop.

The consequence was reachable through the round-7 fix: keeping the crash edge open for retry was
right, and the retry then reported a confident `child-died`, because `pid-dead` was mapped
unconditionally onto that cause and nothing recorded that the shutdown had reached the child
without killing it. The honest uncertainty could not survive the retry because there was nowhere
to keep it.

**The fix is to persist the classification.** Each entry now carries what the shutdown OBSERVED
— `alive-and-killed`, `already-gone`, or `could-not-sample` — and an entry is written for EVERY
outcome, not only for a kill. That reverses an earlier decision deliberately: the old reasoning
was that a record would EXCUSE a death we did not cause, and that was right about a record which
can only say "we killed this". It is wrong about one that says what was observed. An
`already-gone` entry excuses nothing; it records that the shutdown reached a child that had
already died.

**The rule, which is bigger than this change:** `false` and `unknown` must not share a branch —
and that applies to durable representations, not only to code paths. A field that cannot express
"I looked and could not tell" will have that state read as whichever neighbour it resembles, and
here it resembled the worst one.

**Audited once rather than per finding.** For every durable field this change writes or reads,
the states the code can be in versus the states the field can express:

| field / union | states needed | verdict |
|---|---|---|
| `killed_by_gateway_shutdown[]` presence | killed, undetermined, never-reached | **2 for 3 — fixed by `observed`** |
| `.pid` | confirmed-dead, confirmed-alive, cannot-confirm | ok (reader is three-valued) |
| `child_crash_notified_at` | reported, not-reported | ok — the domain IS two-valued |
| `ChildCrashCause` | child-died, gateway-shutdown, unknown | ok |
| `ShutdownLivenessSample` | alive, already-gone, could-not-sample | ok |
| `WedgeReason` dead-child arm | crash, deploy, undetermined | **2 for 3 — fixed** |
| `LauncherLiveness` | alive, unknown, dead, deploy-killed, undetermined | **missing 1 — fixed** |
| `durablyRecorded` | recorded, not | ok — the domain IS two-valued |
| `trident_launcher_crashes.failure_reason` | precedence between writers | deferred → #648 |

Three gaps, three fixes, and the two that were already three-valued needed nothing. That table
is the question that would have caught this finding, the quarantined-generation gap and the
attributed/reported conflation in one pass instead of three rounds.

`markKilledByGatewayShutdown` is renamed `recordGatewayShutdownOutcome`, because a function
named for killing that also records "already gone" is a name whose plain reading is false.

### This advances #518; it does not close it

Recorded here because the temptation is to move the ITEM rather than the marker. The item
is "a deploy must not kill the builds in flight". What landed is the reporting: every
launcher this gateway kills on its way down says so, instead of surfacing as a crash. The
killing itself is unchanged — `shutdownAllPersistentRepls` and `shutdownQuarantinedChildren`
still terminate every pooled and quarantined child — and criterion 1's own analysis says
why nothing inside this process can change that while the REPL lives in the gateway's
cgroup. So the PR carries no `Closes`, the issue stays open against the drain/survive half
(#538/#539), and criteria 1 and 2 stay unticked.

### A state that aborts its reader is not represented, only spelled

`sampleLivenessBeforeShutdownKill` catches a throwing liveness probe and records
`could-not-sample`: the third value exists precisely because "is it dead" can fail to
answer. `confirmShutdownExits` then read the same `hasExited()` UNPROTECTED, three times —
the pending filter, the escalation skip, and the final promotion. A child whose probe threw
did not produce an undetermined outcome there; it rejected out of the phase, so the
escalation, the second grace, the confirmations of every OTHER watch, the ephemeral
teardown and the whole delivery phase never ran. The children behind that watch lost both
channels, which is exactly the loss the pending-spawn partition had just closed by a
different route.

Every confirmation read is now three-valued. `readHasExited` returns `true | false |
undefined`, and each caller says what it does with the third: the pending filter WAITS for a
child it cannot read (the grace is shared and being spent anyway), the escalation SIGNALS it
(`kill()` is idempotent after exit, so signalling a dead child costs nothing while skipping
a live one orphans it), and the promotion refuses — signalled but unreadable is undetermined,
with a stderr line naming which of the two it was. `readChildPid` is the same rule one field
over: both walks read `pid` inside the marking step that PRECEDES the kill, so a throwing
getter cost the pooled child its kill and aborted the quarantined loop outright.

### The standing check this lane earned

Three rounds in a row found the same shape, so it belongs in the record as a check rather
than as a third anecdote:

> **For every state in the vocabulary: which code paths read it, and does each of them
> SURVIVE it?**

It is the sibling of the consumer sweep two sections down. That one asks whether a consumer
treats a report as proof of something the report declines to assert; this one asks whether a
consumer can tolerate the value at all. Both are about the same gap between a vocabulary and
its readers, and in both the defect is invisible from the writing site — the value is
correct, and the damage is somewhere that reads it.

Also worth keeping: each time, the coverage was ADJACENT. A throwing probe was exercised in
isolation while the delivery case used a hand-built report, so nothing drove a throwing child
through confirmation. A never-settling SINK was covered while the unsettled POOL PROMISE was
not. The fixture was always one seam away from the path.

### The guarantee held only until the first wedged spawn

`pool` stores the spawn PROMISE and inserts it into the map BEFORE it settles, so an entry
can be a spawn still in flight — or one that never finishes. The shutdown walk awaited each
entry in turn. So a single unfinished spawn sat in front of every later child's MARKER AND
KILL: this function's own production note measures that at ~40 s against a 30 s
`TimeoutStopSec`, which means the children behind it were killed by the cgroup with NEITHER
channel having reported. Every careful thing this change does — mark before kill, confirm
the exit, withhold what was not established, keep the record readable — applied only to the
launchers ahead of the first wedged entry. And the failure is silent in the worst way: the
build that gets no report is the one whose gateway was already in trouble.

THE SAME DEFECT THE REPORTING PHASE WAS SPLIT OUT TO AVOID, one phase earlier. The module
already refuses to let a sink it does not own sit between one child's kill and the next
child's marker; the traversal was letting a SPAWN it does not own do exactly that.

`Bun.peek.status` reads the settled state synchronously — the same synchronous-mirror trick
`supervision.ts` uses on this map — so the walk now partitions first and handles every
settled entry before waiting for anything. The unsettled ones then share ONE bounded wait
(`SHUTDOWN_PENDING_SPAWN_GRACE_MS`, 2 s, the same size as the exit grace); a spawn that
lands inside it is marked and killed like any other child, and one that does not is named
on stderr and left to the cgroup, with a best-effort kill attached in case it settles while
this process still exists. Nothing durable is written for it, and that is not a gap: a pool
entry that never resolved has no `child_generation` to attribute anything to, and never had
a turn injected into it, so it hosts no detached workflow. The builds at risk are behind the
settled entries — which is exactly why those go first.

The drain's budget is now bounded by its own phases (~2 s exits + ~2 s pending spawns + ~5 s
reporting) rather than by the slowest spawn, and the timing note in `gateway/index.ts` that
described the old behaviour is corrected rather than left to read as current.

WHY THE EXISTING CASES MISSED IT: they covered a never-settling **sink**, not an unsettled
**pool promise**. Adjacent shapes, and only one of them is on the traversal — the bounded
thing was tested and the blocking thing was not.

### A record that survives without the thing that makes it readable

The authoritative write was made independent of the journal entry — the right fix — and
reconstructed its entry from the report with the pid alone. So in exactly the case that fix
exists for, a lost journal entry, the surviving record carried a number and nothing that
says which process the number was. The next boot's probe classified it `unverifiable`, found
the pid absent, and reported `dead-cause-undetermined` for a death the shutdown had
CONFIRMED — while the promotion returned true, the report said `alive-and-killed`, and the
spec item promised that attribution survives whenever the durable channel does.

The identity now travels on `PendingShutdownKillReport` (sampled once, pre-kill, because
afterwards the pid may be free) and into the confirmed upsert. Where the journal entry
exists but predates the field — a rolling restart from an older build — the confirming write
FILLS IT IN and never overwrites: an entry's identity belongs to the process that entry is
about.

WHY THE SEQUENCE TEST COULD NOT SEE IT, which is the part worth keeping: after deleting the
provisional entry it handed `shutdownObserved: 'alive-and-killed'` to `detectReplWedged`
directly. The fixture supplied the value whose DERIVATION was the thing under test, so a
case named for a sequence tested one step of it and passed on a record no reader could use.
Both cases now drive the real next-boot probe (`probeLauncherGenerationAlive`) against a
real, killed process — an invented pid has no `/proc` entry, so nothing is sampled and the
case would have asserted the recovery while exercising the unverifiable fallback.

### An honest value, delivered down a channel that lies

The report for a child whose kill did not land carried `cause: 'unknown'` — accurate, and
sent to `onChildCrash`, whose production implementation latches `crashRunningByLauncher`
and marks every still-running trident run on that launcher `crashed`. So THE CHILD THAT
SURVIVED THE DEPLOY — the one case this item exists to protect — had its live build
durably marked crashed by the change that exists to stop deploys from killing builds.

This is the `attributed` defect one layer out. There a claim was derivable before the act;
here the DESTINATION asserts death regardless of what the value says. A death sink may not
be called until a death is established, and only two observations establish one:
`alive-and-killed` (an exit observed after a signal we delivered) and `already-gone` (the
child was gone before we arrived). `alive-when-reached` and `could-not-sample` do not — the
child may still be running. Those are now WITHHELD from the sink, reported instead on
`postWedgeAlert`, the tree's existing notify-only seam, which touches no run row; the crash
edge stays OPEN so a death that does happen is still reported by a reader that confirms it
against the process table first. The tally grew a `withheld` arm, because a report nobody
was told must be distinguishable from one that was.

Pinned end-to-end against the REAL store in `open/wiring/__tests__/`: an unestablished
disposition leaves `subagent_status = 'running'` and `failure_reason` null, with the
complement that a confirmed kill still writes the deploy reason and an `already-gone` child
still lands a row — withholding everything would restore the silence this change removes.

### The consumer sweep

The root finding was not the sink; it was that this work made the ATTRIBUTION careful and
left every CONSUMER of it unexamined. So they were swept — who reads an outcome, and does
any of them treat a report as proof of what it declines to assert:

| Consumer | Reads | Does it assert a death nobody established? |
|---|---|---|
| `onChildCrash` (prod: `open/wiring/trident-child-crash-sink.ts` → `crashRunningByLauncher`) | the shutdown report's `cause` | IT DID — fixed above by gating the CHANNEL, not the value |
| `deliverShutdownKillReports` → `closeCrashReportEdge` | delivery, not verdict | No — and a late commit now closes it too (below) |
| `detectReplWedged` (`dead-repl-detector.ts:96`) | `shutdownObserved` | No — every dead-child arm sits under `!probe.childAlive`, a liveness fact, and the observation only picks the SENTENCE |
| `probeLauncherGenerationAlive` (`supervision.ts:1035`) | the durable entry | No — the pid + identity check must independently say gone; the entry only explains |
| `open/wiring/trident-launcher-liveness.ts` | two verdicts | No — `DEAD_VERDICTS` gates the merge and a non-observation never overrides an observation |
| `trident/tick.ts:648` liveness loop | the merged verdict | No — it acts only on a dead verdict, which the probe established |

One finding fell out of the sweep that is NOT this PR's and is NOT fixed here: the
supervision watchdog calls the crash sink for ANY wedged verdict
(`supervision.ts:497-503`), including `no-port-listener` — a child that is ALIVE but
silent — and on an `alert-only` / `cap-hit-alert` tick nothing then kills it, so a live
launcher's runs are latched `crashed`. It is identical on `origin/main` (verified against
`git show origin/main:runtime/adapters/claude-code/persistent/supervision.ts`, same
`action.kind !== 'ignore' && verdict.wedged` gate), i.e. it is #514's reaping design rather
than anything this branch introduced, and changing it changes what #514 delivers. Recorded,
and filed as **#655**, rather than folded in, because widening this PR into a second item is the error
the scope ruling above just corrected.

### Abandoned is not cancelled

The per-sink bound stops us WAITING; it does not stop the sink. The call is still in
flight, and the production sink's commit is a durable write to the run row — so a sink that
answered a moment after its bound committed a failure reason while the crash edge, keyed on
our having waited, stayed open. The next boot then reported the same death again, over the
top of a reason that had already landed, straight into the last-writer-wins hazard this
record documents two sections down. The timeout tests covered "never settles", which is the
case where the two paths do NOT both run.

A late SUCCESS now closes the edge exactly as an on-time one does, and says so on stderr; a
late FAILURE leaves it open, which is what the backstop is for. Three cases, because the
pair alone is satisfied by closing unconditionally.

### A bound that is also a floor is not a bound

`Promise.race([work, sleep(ms)])` settles the AWAIT when the work wins. It does not stop
the timer, and a pending timer holds the runtime open — measured at 2.01 s for a race
against `Bun.sleep(2000)`. Both waits in this module were therefore floors as well as
ceilings: a shutdown whose children were already gone and whose sinks answered instantly
still sat out the grace and the per-sink budget, inside a `TimeoutStopSec` systemd is
counting and the rest of the teardown shares. Both are now `BoundedWait` handles
(`expired` + `cancel`) released in a `finally`, and the injectable seam has the same shape.

WHY EVERY EXISTING CASE MISSED IT, which is the transferable half: the deterministic tests
injected a wait that resolved at once and recorded the requested budget. That made the
BOUND observable and the TIMER unobservable — a fake that replaces the mechanism removes
the property the mechanism has. Process liveness is only observable in a process, so the
new case runs the real code in a subprocess and measures how long that process lives, with
a LEAK CONTROL (the same script plus one uncancelled race) that must take the full budget.
Without the control a fast machine would "prove" cancellation on code that never cancelled.

### A pid is an identifier, not a handle

Every reader that confirmed a launcher's death confirmed it against a stored NUMBER, while
the entry carrying that number stays eligible for four hours — and pids are reissued well
inside that on a busy box. Two different wrong answers followed. A reissued pid answered
`process.kill(pid, 0)` exactly like a live launcher, so a DEAD child read as alive and its
build waited out the 90-minute reaper: this item's own lag defect, arriving through the
process table. And an absent pid was read as evidence about our child when the number may
have been handed on and released since.

`process-identity.ts` stores what the kernel maintains and a reissued pid cannot reproduce:
`/proc/<pid>/stat` field 22 (start ticks) plus `/proc/sys/kernel/random/boot_id`. Start
ticks are counted FROM boot, so without the boot id two processes from different boots can
share a pid and a start time and the comparison silently compares two clocks. The verdicts
are four, not two: `ours-alive`, `confirmed-gone` (a reissued pid proves ours released it —
a running process keeps its pid), `not-comparable` (another boot: nothing behind that entry
can still be running), and `unverifiable`. An UNREADABLE boot id is `unverifiable`, never
`not-comparable`, because "this host cannot answer" and "that process cannot be alive" are
different facts — the `false`/`unknown` split this item has now paid for three times.

The consequence for attribution is the conservative one: with no stored identity (an entry
from an older build, or a host with no `/proc`) an absent pid still establishes a DEATH but
attributes nothing, so the death is reported `dead-cause-undetermined` rather than as a
deploy. Verification comes before the ESRCH evidence is used, which is what the blocker
asked for; the stamped path keeps the attribution because the identity ties the record to
the process and the observation behind it was promoted only by an observed exit.

Field 22 is parsed from the LAST `)` in the line, not the first: `comm` is attacker- and
accident-controlled (a process can call itself `claude (repl) 1`) and a naive split reads a
number out of the name and stamps a WRONG identity — worse than none, because it compares.

### The backstop was the primary rule under load

`pruneGatewayShutdownKills`'s contract said young entries are retained and the cap may only
take what age-or-reference already released — and then capped every *unreferenced* entry,
young ones included. With more entries than the threshold all genuinely inside the window,
the "backstop" became the primary rule and dropped the oldest still-live attribution: the
loss this mechanism exists to prevent, under exactly the load that makes it likeliest.

**It does not need to evict at all, which is the part worth recording.** The age rule
already bounds growth — everything outside the retention window is released, so a row holds
at most the shutdowns that landed on one session key inside that window. The count cap was
guarding a bound that already existed. So it is now an ALARM: crossing it keeps every entry
and says so loudly, because the situation it describes (a restart a minute, sustained for
hours) is a thing to report, not a reason to discard evidence — and `restart-rate.ts` is
what exists to catch the cause. `GATEWAY_SHUTDOWN_KILL_HISTORY` is renamed
`GATEWAY_SHUTDOWN_KILL_ALARM_COUNT`, because a constant named for a retained count that
retains nothing is a name whose plain reading is false.

### "Is it dead" is not "is it dead because of us"

The third position of one sentence on this item. `attributed` was derivable before the act;
then a `kill()` that merely RETURNED was read as a kill that worked; and then an exit that
happened anyway was read as our kill. Each fix moved the evidence closer to the act, and
none of them recorded whether the act SUCCEEDED.

`hasExited()` answers "is it dead". Attribution needs "is it dead BECAUSE OF US", and the
only thing that can establish the second is whether our signal was delivered. So
`ShutdownExitWatch` carries `signalDelivered` — set by the caller for the initial signal,
raised by the escalation when the SIGKILL lands — and promotion requires BOTH it and the
exit. A child whose signal failed and which then died of something else is dead, and not by
us: undetermined, never a deploy.

The previous coverage had a child that stayed ALIVE, so the causal boundary was untested:
an independent exit during the grace was indistinguishable from our kill. It is now driven
at the live push path — our signal throws, the child dies anyway, and the report must not
say deploy — with the complements that a delivered signal plus an exit IS a kill, and that
the escalation landing makes a subsequent death ours.

### The ticked box was a claim the code could not falsify

A successful kill is persisted as `alive-when-reached` before the act and promoted to
`alive-and-killed` after it. When the promotion failed the record was deliberately left
weaker and said so — but if the bounded live sink then failed too, the next boot could not
name the deploy, while a **ticked** acceptance criterion said a deploy-caused death is
never reported without naming it.

**Measured before choosing between the two honest resolutions**, because the measurement
decided it: when the PRE-kill write fails there is no entry at all, so the next boot's
detector returns `pid-dead` / `pooled child exited` — a bare crash, on a path that exists
independently of the promotion split and which the box was already ticked over. Making the
durable operation atomic cannot fix that: both channels are stores this process does not
control, and an absolute guarantee about a write it cannot force is unfalsifiable by the
code beneath it. That is the `attributed` defect one layer up, at the specification.

So: **both halves.** Strengthen what is actually mine, and untick.

**Strengthened.** The confirmed write is now an independent upsert rather than a map over
an entry that must still be there. It previously bailed when the pre-kill entry was missing
or the array malformed, which made the CONFIRMED outcome depend on the PROVISIONAL one
surviving — two ways to lose a record where the act justifies one. The journal is a
journal; the post-exit write is authoritative and stands alone — and it carries the
PROCESS IDENTITY as well as the pid, which round 18 had to add: see below.

**And the live channel stops being interchangeable when it is the only one.** A report
whose durable record does not match it is delivered FIRST. That costs nothing — no extra
waiting, the same bounds — and spends a scarce budget on the reports that cannot be
recovered without it.

**Unticked, with the guarantee stated precisely** on the spec item: what survives (either
channel alone suffices, and they fail independently), what is reported when attribution
cannot be established (*cause not established* — never an unobserved crash, never an
unperformed deploy), and the exact residual (the row is lost or unwritable AND the sink
fails, same generation, same shutdown).

**Pinned as a sequence, not as wording.** The previous coverage checked the diagnostic
sentence for a hand-built weaker record — a fixture standing in for a sequence, which is
the fixture deciding the outcome. It now drives durable-write-lost → live-report-lost →
next boot and asserts the bare-crash outcome the owner actually gets, with the complement
that a surviving durable record names the deploy with no live report at all.

### A kill that failed is not a kill

The purest form of the shape this change kept hitting: **`attributed` was sampled before the
act and consumed as though it described the outcome.** It was computed from the pre-kill
liveness sample; the shutdown queues the report, calls `session.child.kill()`, swallows a
throw, and delivery converted every pre-sampled-alive report straight to
`cause: 'gateway-shutdown'`. An alive child whose kill threw was therefore reported as a
deploy kill **while it was still serving**, and the production sink crashed a build that was
still running. A pre-kill sample answers *"was it alive"*; the report asserts *"we killed
it"*. Only the second was being published.

**The fix is not to sample again.** It is that a report of a kill must not be DERIVABLE
before the kill returns. `PendingShutdownKillReport.attributed` is gone; the report carries
the OBSERVATION, and delivery derives the cause from it. `'alive-and-killed'` is reachable
only through `confirmShutdownKill`, which runs after `kill()` returns.

**Queued before the kill, confirmed after — and here is why, since both orders have a
failure mode.** Queuing *after* the kill would mean a process that dies between the kill and
the record leaves nothing at all, and the death reports on the next boot as an ordinary
crash: this item's original defect, reintroduced in a narrow window. Queuing *before* and
amending later is only dangerous if the thing queued is a CLAIM — so the thing queued is not
a claim. The pre-kill record says `alive-when-reached`, a fourth observation meaning
"observed alive when the shutdown reached it; what the kill did is not established". That is
true at the moment it is written, attributes nothing, and if this process dies in the window
it leaves an honest *cause not established* rather than either silence or a deploy claim
nothing performed. The window holds no unestablished claim because the value written into it
asserts nothing.

**The swallowed throw is now its own record.** Shutdown continuing past a failed kill was
always right; what was wrong was letting the earlier optimistic report stand. `pool.ts` and
`spawn.ts` both wrap the kill and call `confirmShutdownKill` with the outcome, so a failure
leaves the disposition explicitly undetermined and says so on stderr.

**And a second defect fell out of the same split.** `recordGatewayShutdownKill` returned
`null` when no sink was wired, which conflated "nothing to DELIVER" with "nothing to
CONFIRM" — so a substrate without a sink never had its record promoted, and a death the
shutdown genuinely caused would have been reported next boot as cause-not-established. It
now always returns the report; the delivery phase already skips one whose sink is absent.

Tested at the **live push path**, as the gate required, not the pull path: a child that is
alive and whose `kill()` throws, asserting the sink is called with a non-attributing cause
and that no excuse reaches disk — paired with the complement that a kill which succeeds
still attributes. The unkillable host WRAPS the working one and overrides only `kill()`,
because a hand-rolled fake that never finishes spawning would have passed for the wrong
reason; the first attempt did exactly that and hung.

### The parser promoted what it did not recognise

The validator checked `generation` and `at` while its own docblock said a malformed entry
must not become positive evidence — and `observationOf` mapped every missing *or
unrecognised* `observed` value to `'alive-and-killed'`, the **most** definite answer
available. An entry written by a newer build than the one reading it reached that with no
corruption at all, and a genuine crash was reported as a deploy.

That is round one's defect with the arrow reversed. Two rounds went into making sure
`unknown` never rides the branch carrying a definite answer; the parser then took a value it
did not recognise and promoted it to the most definite one there is. **An unrecognised enum
member is the canonical unknown**, and a forward version is what makes it reachable without
corruption.

`observed` is now **required**, validated in `gatewayShutdownKillEntryFor` so a malformed
entry is not found at all, and `observationOf` is a narrow accessor that re-checks rather
than assumes.

**There is no legacy arm, and that is measured rather than assumed.**
`killed_by_gateway_shutdown` has **zero occurrences on `origin/main`** — the container and
`observed` ship in the same unmerged change, so no build has ever written an entry without
it. A compat arm would have covered nothing while silently promoting every corrupt and
forward-version entry. That is the deliberate decision the shape asked for: the legacy shape
does not exist.

### The cap answered "how many", when the question was "what can still be referenced"

Retention was the newest 16 entries, justified by trident's two-hour in-flight ceiling. **A
time ceiling bounds duration; a count cap is driven by restart rate, and nothing ties the
two** — so the justification was an assumption about the environment that had not been
measured. Sixteen restarts on one session key inside the window evicted a generation that
still owned a running build, and its attribution was unrecoverable: the stranding this
change exists to prevent, caused by the cap meant to be harmless.

So the rule now bounds what actually determines reachability. An entry is kept when it is
**inside the retention window** (`GATEWAY_SHUTDOWN_KILL_RETENTION_MS`, derived from
`DEFAULT_MAX_INFLIGHT_MS` in `trident/liveness.ts` — 2 h — and doubled for margin, because
the coupling is documented rather than enforced across the band boundary) **or a live run
still references its generation**. That second test goes through `hostsLiveWork`, the same
per-generation seam the pool already consults before evicting a child that hosts live work:
the identical question, one layer down, asked about a record rather than a process.

The count cap survives only as a backstop against a pathological restart loop, at 256, and
it is logged when it bites.

**The first version of this fix reintroduced the bug in its own backstop**, and its own test
caught it: the backstop sliced the newest N, and the oldest surviving entry is exactly the
one a long-running build is most likely to need. A referenced entry is now never evicted
whatever its age or the row's size; the cap is filled out with the newest *unreferenced*
entries.

**And the boundary test tested the mechanism, not the property.** It asserted that eviction
happens — it could not see that eviction had taken an attribution a running build still
needed. Replaced by the repro as a property: `g0` owns a running build, its report fails,
far more than the cap's worth of later generations are recorded, and `g0`'s attribution is
still recoverable. With its complements: an unreferenced entry outside the window IS
released, a young entry is kept whatever the probe says, a throwing probe never protects and
never crashes, and the production path really threads `hostsLiveWork` — the last one added
because a mutation that stopped threading it survived every unit case that passed
`stillReferenced` in directly. Proving the rule is not proving the wiring.

### Which question is this function asking?

That sentence is the one that would have caught the last three findings in one go, so it is
the heading rather than a footnote. Every function touching the shutdown record is listed with
the question it asks, because the bug each time was a function answering a three-valued
question with a two-valued mechanism — or a two-valued one being widened for no reason.

| function | its question | valued |
|---|---|---|
| `observationOf` | what did the shutdown observe here? | 3 |
| `wasKilledByGatewayShutdown` | did WE kill this child? | 2 (a yes/no about one observation) |
| `gatewayShutdownKillEntryFor` | where is the entry for this generation? | lookup, not a classification |
| `recordGatewayShutdownOutcome` idempotence | does an entry already exist? | **2, and correctly so** |
| `recordGatewayShutdownOutcome` read-back | did my write land? | **2, and correctly so** |
| `probeReplLiveness` | what should the detector be told? | 3 (passes the observation through) |
| `detectReplWedged` | which dead-child verdict? | 3 |
| `probeLauncherGenerationAlive` current row | is it dead, and why? | 3 |
| `probeLauncherGenerationAlive` historical | is it dead, and why? | 3 |
| `allDead` (the combiner) | **is it dead?** — liveness ALONE | 2 over a 3-member set |
| `mergeAttribution` (the combiner) | **why did it die?** | 3, plus a disputed row |

The last two are the round-10 finding. A merge function is not a reader of one entry — it is a
reader of two verdicts — so it sat outside a call-site audit of entry readers, which is how a
value added to the vocabulary, the writers and the readers missed the COMBINER, a fourth place
after the entry encoding, `WedgeReason` and `LauncherLiveness`.

### The combiner merged two questions on one lattice

`dead`, `killed-by-gateway-shutdown` and `dead-cause-undetermined` all answer **yes** to "is it
dead?" and differ only on **why**. The combiner treated only `{dead, killed-by-gateway-shutdown}`
as unanimous death, so a `dead` + `dead-cause-undetermined` pair — two homes BOTH positively
establishing death — fell through to `unknown`, the tick ignored it, and the run hung until the
later timeout. The stranding this item exists to remove, arriving through the merge instead of
the record.

Split into two lattices, resolved in order, neither reachable only by fallthrough:

**Liveness.** Any set drawn entirely from the three dead verdicts is unanimous death. Every
answer `alive` is alive. Mixed is `unknown` — a live process anywhere forbids reaping. So
`unknown` now means "a home could not tell whether it is alive", never "the homes disagreed
about why it died".

**Attribution**, an explicit table where an attribution survives only if nothing contradicts it:

- `killed` + `undetermined` → **killed**. A NON-OBSERVATION NEVER OVERRIDES AN OBSERVATION —
  the same rule that made the shutdown persist what it observed rather than infer it.
- `dead` + `undetermined` → **undetermined**: the claim both homes support. Plain `dead` would
  have the tick compose a crash sentence that one home has evidence against.
- `dead` + `killed` → **disputed**, reported as `dead-cause-undetermined` and logged loudly.

**That last row required checking what plain `dead` asserts, before deciding.** It is positive in
both provenances and never arises from a failed look: the pool branch answers it for a session
that by construction has not been through a shutdown (`pool.ts:962` deletes the pool entry
before the record is written at `pool.ts:1008`), and the registry branch answers it only when a
look for an entry naming this generation found none. So it is a real conflict between two
positive attributions, not `dead-cause-undetermined` wearing the wrong name — and it is not
resolved by preferring an arm, which is what an earlier revision did. A disputed cause IS an
unestablished one, so the existing third value carries it and no fifth value is invented.

A generation lives in one instance's registry (per-spawn UUID), so the disputed row is
unreachable by construction today. It is resolved rather than asserted away, because an
unreachability argument is not a reason to let a conflict launder itself into a confident
sentence if the arrangement changes.

**The matrix is now the cross-product**, not the rows that happened to be written: all fifteen
unordered pairs over the five verdicts plus the singletons, both orderings asserted, and the
test fails if a pair has no declared expectation or if a declared row is unreachable. Each new
rule is mutation-checked on its own.

### Two rules the tooling earned this round

**A helper that finds a line is not a helper that finds the right line.** The content-check
verifier exists because citations drift; automating the re-derivation then introduced its
own false positives. The helper took the first `grep` match, which for
`session.child.kill()` is a *comment mentioning the call* and for the store guard is a
different statement with identical text. Both were caught by the content check — the
automation was wrong and the assertion about the automation was right, which is the only
reason the drift did not ship.

**A read-back with no reachable failure is unfalsifiable, so the mutation moves to the
property it owns.** M74 (and M8 before it) survived because the read-back's failure needs
fault injection the tree has no seam for. Retargeted at what the read-back is actually
for: with the write turned into a no-op, the function must report false rather than claim
success. Counting an unkillable mutation as coverage would have been the mutation table
lying the way the tests it polices can.

### Auditing fields was the wrong denominator; the readers are

The three-valued record fixed the writers and left a reader keyed on the old
representation. `probeLauncherGenerationAlive`'s CURRENT-row branch asked only whether some
entry carried a timestamp, so `already-gone` and `could-not-sample` both answered
`killed-by-gateway-shutdown` — the owner told a deploy had killed a build that died on its
own. The historical-entry branch, four lines below, already classified correctly. **Two
readers of one field, one updated and one not.**

The previous round's audit enumerated FIELDS and found three gaps. That denominator cannot
catch this: the field was right, and a consumer of it was wrong. So the audit is redone over
CALL SITES. **Eleven readers checked, one defective:**

| reader | question it asks | verdict |
|---|---|---|
| `wasKilledByGatewayShutdown` | `observationOf(...) === 'alive-and-killed'` | ok |
| `observationOf` | the classifier itself | ok |
| `gatewayShutdownKillEntryFor` | locates an entry, does not classify | ok |
| ~~`gatewayShutdownKillAt`~~ | "is there a timestamp?" | **DELETED — see below** |
| `recordGatewayShutdownOutcome` idempotence check | "does an entry exist for this generation?" | ok — presence IS the question |
| `recordGatewayShutdownOutcome` read-back | "did the write land?" | ok — presence IS the question |
| `observationFor` (supervision) | delegates to `observationOf` | ok |
| `probeReplLiveness` | feeds `shutdownObserved` through | ok |
| `probeLauncherGenerationAlive`, current row | presence test | **THE DEFECT — fixed** |
| `probeLauncherGenerationAlive`, historical scan | `observationOf(entry) === 'alive-and-killed'` | ok |
| `detectReplWedged` | three arms over `shutdownObserved` | ok |

Two of the eleven ask about presence and are RIGHT to: "does an entry already exist" and "did
my write land" are genuinely two-valued questions. The distinction that matters is not
presence-versus-classification, it is whether the question the caller is asking is itself
three-valued.

**`gatewayShutdownKillAt` is deleted rather than fixed, because its TYPE was the defect.**
`number | undefined` cannot express three observations, so it invited the presence read from
its caller — and would have invited it from the next one. Nothing in production wanted the
timestamp. An accessor that collapses a three-valued domain into presence-or-absence is a trap
with a return type; removing it removes the trap.

**And the suite could not have caught it.** Every undetermined case advanced
`child_generation` before probing, so all of them exercised the historical scan; the
current-row branch had no undetermined coverage at all. Three cases added — `already-gone`,
`could-not-sample`, and `alive-and-killed` as the complement — asserted separately rather than
in a loop, so the mutation run shows each killing the mutant on its own (M55 reddens the first
two individually; M56 reddens the complement).

### The edge is keyed on delivery, never on the verdict

The crash edge records that a death's report HAPPENED. An earlier revision closed it only for
the ATTRIBUTED case, so a successfully delivered `cause: 'unknown'` left it open — the next
watchdog tick then passed the reporting gate and reported the same death as a confident
`cause: 'child-died'`, which `crashRunningByLauncher` writes over the tombstone
unconditionally. The honest "I could not tell" was replaced by a confident "the child died":
this change's own defect, by a new route.

`delivered` and `attributed` are different facts. Telling the owner something and telling the
owner it was a deploy are not the same claim, and only the first closes this edge.

**The generalisation, because this is the same conflation round 4 split apart.** Round 4
separated the attribution from the report because *the attribution is knowable before the kill
and the delivery is not*. Round 6 then added a third state, `unknown`, and left the close
condition asking round 3's question. Nothing about that condition was wrong when it was
written — `unknown` was not a possible value then. **So: every new state has to be checked
against every field whose meaning was defined before that state existed.**

Three tests asserted the old state (`child_crash_notified_at` undefined) rather than the
property. They are corrected, and the property is pinned as a SEQUENCE: deliver an
undetermined report, run a watchdog tick, assert no second notification — with the complement
that an UNDELIVERED report still leaves the edge open and the next tick does report it.

### Deferred deliberately: the tombstone's last-writer-wins

`crashRunningByLauncher` overwrites `failure_reason` unconditionally on conflict
(`trident/store.ts:1367-1370`), so when two detectors disagree the last to arrive wins — and it
is frequently the least informed. Filed as its own item rather than fixed here: neither
"last writer wins" nor "first writer wins" is correct (a better later report must still be
able to replace a worse earlier one), so the field needs an argued precedence over reason
kinds, and `crashRunningByLauncher` is the shared tombstone for every launcher-death detector
rather than anything specific to deploy attribution.

Measured reachability, so the deferral is informed rather than convenient: the run row's own
reason update is guarded by `subagent_status = 'running'` (`trident/store.ts:1383`) and the
pull half skips terminal runs (`trident/tick.ts:648`) — but `saveIfActive`'s veto path re-reads
the tombstone and stamps it onto the row (`trident/store.ts:1984-1995`), guarded only by the
CALLER'S SNAPSHOT of `subagent_status`, not by the row's current value, so an
overwrite can reach a row given that race. This change closes the duplicate-report routes into
it, which makes it a sharp edge behind a race rather than an everyday path.

### Measured

101 mutations applied one at a time, each reverted after: **101 red, 0 survivors.** Every
deploy-arm mutation is paired with its inverse (make the arm unconditional), and each
inverse reddens a different test than the deletion does — the pairing is what makes the
negative acceptance criteria checks rather than prose.

Two entries in that table are worth their own sentence, because the mutation run found them
rather than confirming them:

- **M15** (delete the quarantine report) initially SURVIVED. The assertion said "at least one
  report, all of them deploys", which the *pooled* child's report satisfied on its own. It now
  names the quarantined generation explicitly.
- **M43** is the round-6 bug exactly: return the attribution from the entry without the
  `process.kill(pid, 0)` confirmation. It is the code round 5 shipped, and it reddens the new
  alive-process boundary while every earlier attribution case stays green — which is what
  makes the pair a check rather than prose.
- Three mutations were RETIRED rather than retargeted: M18, M22 and M23 targeted the
  round-2 refusal guard and clear-on-respawn, which the per-generation list deletes. A
  mutation for a guard that no longer exists is not coverage, and keeping the guards alive to
  preserve a count would have been the tail wagging the dog. The properties they protected are
  now covered by M36 (single-slot marker restored → the quarantined generation disappears),
  M40 (spawn clears the history → the quarantined record is lost) and M39 (the probe matches
  any entry rather than this generation → absence read as attribution).
- **M68 became EQUIVALENT and was replaced rather than counted as a pass.** It derived the
  delivered `cause` from the PRE-kill liveness sample instead of the confirmed observation,
  and it used to red on the unkillable-host case. With the withholding gate that case no
  longer reaches the sink at all — and on every report that DOES, the two expressions
  agree, because `confirmShutdownKill` promotes only from `alive-when-reached`. A mutation
  whose output cannot differ is not a surviving mutant; it is a mutation the design has
  subsumed. It is now "report every delivered outcome as a deploy", which the already-gone
  case reds, plus **M97** on the promotion guard itself, which is where the property
  actually lives now.
- **M86** (drop the boot-id comparison) SURVIVED, and the reason is the finding: a second,
  redundant boot comparison after the `/proc` read could never fail, and a check that
  cannot fail MASKS the one that can. Deleting the real guard left every case green. The
  redundant line is gone; the mutation reds.
- **M39** (match any entry rather than this generation) survived once the fake children
  became real processes: the complement case probed before the killed pid had actually
  left the process table, so the wrong entry read as `ours-alive` and the case passed for
  the wrong reason. It now waits for the real exits — a race this test file creates and
  production does not, because production's reader is the next boot.
- **M55** (the current-row presence test again) survived the identity work until the two
  UNDETERMINED current-row cases were stamped with an identity: unstamped, they exercised
  the unverifiable fallback and left the confirmed-gone branch covered only by cases whose
  observation was `alive-and-killed`, where the mutation gives the same answer. Every new
  state has to be checked against every case whose path predates it.
- **M65 RETIRED**, not counted: it targeted the `survivors` slice in the old backstop,
  which no longer exists now that the threshold evicts nothing. Its property — never evict
  a referenced entry — is subsumed by **M79** (restore the eviction), which is strictly
  stronger because it also evicts YOUNG entries. A mutation for code that is gone is not
  coverage.
- **M82** (have the caller always claim its signal landed) survived its first run, because
  the live-path case had a child that never exits — so the forced claim was masked by
  `hasExited()` being false. The case that is not masked, our signal failing while the
  child dies anyway, was added and it reds.
- **M31** (drop the per-phase clamp) survived its first version, and that is what established
  the paragraph above: the clamp changes no count, so only an elapsed-time assertion can kill
  it. Retargeted with a justified opt-out rather than left unfalsifiable.
- **M27** (restore the early `child_crash_notified_at` stamp) reddens ONLY the new sequence
  test. Every shutdown-half assertion still passes under it — the marker is written, the
  throw is caught — which is precisely why an artifact-shaped test could not see the defect.
- **M8** (have `markKilledByGatewayShutdown` return `true` instead of reading the row back)
  survived once the row-scoping guard landed, because the guard now returns first for every
  case the test could construct. The read-back is NOT redundant — it still catches a save
  `withRegistry` skips inside the lock on a whole-file read error, which the guard cannot see
  — but there is no injection seam to reach that path, so M8 was retargeted at the property
  the read-back actually owns: with the write turned into a no-op, the function must report
  false rather than claim success.

`scripts/ci/typecheck-all.sh` (51 tsconfigs), `scripts/ci/lint.sh`,
`scripts/ci/depcruise.sh`, `scripts/ci/leak-gate.sh` and the partitioned test suite all
run green.
