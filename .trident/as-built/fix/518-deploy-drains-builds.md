## 2026-09-12 — a deploy that kills a build in flight says so, instead of reporting a crash

Spec item: `docs/spec-items/a-deploy-must-not-kill-builds-in-flight.md` (#518, P0, cutover
milestone 2).

### What was actually happening

A trident inner workflow is not its own process: it runs detached inside a warm `claude`
REPL the gateway owns (`cc-trident-fire-<owner>-<repo>`, composed in
`open/wiring/substrates.ts`). The spec item says a service restart "SIGTERMs that REPL",
which understates it — the gateway's own SIGTERM handler calls
`shutdownAllPersistentRepls` (`gateway/index.ts:1045`), which walks the pool and calls
`session.child.kill()` on every warm child (`pool.ts:996`). We kill it. Three of five
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
early (`spawn.ts:848`). Every deploy killed those silently.

### The choice the spec item demanded, and why it is what it is

Acceptance criterion 1 offers two mechanisms: drain/defer, or the workflow survives its
launcher's restart. The architecture rules.

**Drain/defer cannot work from inside this process.** A deploy ends in
`systemctl restart`; the unit is `KillMode=control-group`, so every descendant is SIGKILLed
at `TimeoutStopSec` no matter what the polite layer decides — `gateway/index.ts:1026-1038`
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
  resolves (`adapters/claude-code/index.ts:509`) — and reports before each kill, with one
  timestamp for the whole teardown. `shutdownQuarantinedChildren` (`spawn.ts`) now reports
  too. An unregistered key writes a stderr line naming what could not be told, rather than
  dying silently.
- **The next boot reads the marker.** `ReplWedgeProbe` gains `killedByGatewayShutdown`;
  `detectReplWedged`'s dead-child branch returns the new reason
  `pid-dead-gateway-shutdown` with a detail that names the deploy. The operator alert texts
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
before a fresh spawn took it over — and they share one registry row (`pool.ts:961`, then
`pool.ts:989`). The later write replaced the earlier one, so the row named one generation
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
(`spawn.ts:868-873`). A marker written at quarantine time would attribute that ordinary reap
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
`record.child_generation` (`supervision.ts:1058`), which a replacement spawn overwrites
(`spawn.ts:675`) — so a quarantined generation has never been locatable in the registry, and
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
whatever we are mid-way through (`gateway/index.ts:1026-1038`); the database closes a few
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
(`supervision.ts:1106-1128`). Round 6's finding was this exact over-claim arriving on the read
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
that by construction has not been through a shutdown (`pool.ts:931` deletes the pool entry
before the record is written at `pool.ts:961`), and the registry branch answers it only when a
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
(`trident/store.ts:1102-1105`), so when two detectors disagree the last to arrive wins — and it
is frequently the least informed. Filed as its own item rather than fixed here: neither
"last writer wins" nor "first writer wins" is correct (a better later report must still be
able to replace a worse earlier one), so the field needs an argued precedence over reason
kinds, and `crashRunningByLauncher` is the shared tombstone for every launcher-death detector
rather than anything specific to deploy attribution.

Measured reachability, so the deferral is informed rather than convenient: the run row's own
reason update is guarded by `subagent_status = 'running'` (`trident/store.ts:1118`) and the
pull half skips terminal runs (`trident/tick.ts:648`) — but `saveIfActive`'s veto path re-reads
the tombstone and stamps it onto the row (`trident/store.ts:1719-1730`), guarded only by the
CALLER'S SNAPSHOT of `subagent_status`, not by the row's current value, so an
overwrite can reach a row given that race. This change closes the duplicate-report routes into
it, which makes it a sharp edge behind a race rather than an everyday path.

### Measured

64 mutations applied one at a time, each reverted after: **64 red, 0 survivors.** Every
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
