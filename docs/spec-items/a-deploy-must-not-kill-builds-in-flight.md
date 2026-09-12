---
title: Stop a deploy from killing the builds still in flight
group: deploy
status: open
priority: P0
cutover: true
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

**A deploy must not kill the builds in flight — trident is presently its own worst enemy**
(owner-directed 2026-08-13, from the forensics on run `bb3c8c8e`). The inner workflow is not its own
process: it runs detached inside a WARM `claude` REPL the gateway owns (`cc-trident-fire-<owner>-<repo>`,
`open/wiring/substrates.ts`). Restarting the instance's service SIGTERMs that REPL and every workflow
inside it, and the wedge watchdog then reports `pid-dead → "pooled child exited"` — the detector
working, not
the fault. Three of five recorded `trident_launcher_crashes` land 18–28 s after a vendor checkout
(08-11 20:16:44→20:17:02, 08-12 19:37:55→19:38:13, 08-13 04:05:27→04:05:55). The 08-13 deploy rolled
`282f10b6`, *trident's own merge*: **a build that lands kills the builds still running**, at exactly the
rate the pipeline succeeds. Acceptance: a deploy either drains/defers while a run is in flight, or the
workflow survives its launcher's restart — and either way the owner is TOLD which happened, never handed
a bare "child crashed" for an event that was a deploy. (Two crashes — 08-10 23:30, 08-11 06:04 — have no
checkout near them and are NOT explained by this; a fix must not be credited with closing them.)
DISTINCT FROM the governance tracker's #514 (*a CRASHED trident run is never reaped*), which asks what
the row does AFTER a child dies and is now served by the `onChildCrash` sink. This asks why the child
dies at all, and answers: we killed it. Fixing one does not fix the other.

## Scope of the work landed so far

PR #642 ADVANCES THIS ITEM AND DOES NOT CLOSE IT, and the issue stays open on purpose.
What it delivers is the reporting half: every launcher this gateway kills on its way down
is recorded and reported as a deploy/restart rather than as a crash. The item's primary
behaviour — a deploy that drains or defers, or a workflow that survives its launcher's
restart — is NOT delivered: every pooled and quarantined launcher is still killed during
shutdown, for the reasons under criterion 1 below. Criteria 1 and 2 remain unticked; 3 and
4 are met. The marker moves when the behaviour does; moving the item instead is how work
disappears.

## Acceptance

- [ ] **A deploy either drains/defers while a run is in flight, OR the workflow survives its
      launcher's restart. One of the two, chosen deliberately and pinned by a test.**
      CHOSEN: *the workflow survives its launcher's restart* — and it is NOT deliverable
      here, so this box stays open rather than being ticked against a check that does not
      exist. Why the choice is forced, established 2026-09-12:
      - **Drain/defer cannot work while the REPL is in the gateway's cgroup.** A deploy ends
        in `systemctl restart`; the unit is `KillMode=control-group`, so every descendant is
        SIGKILLed at `TimeoutStopSec` regardless of what our polite layer decides
        (`gateway/index.ts:1026-1045` says so in as many words). A `hostsLiveWork` gate on
        `shutdownAllPersistentRepls` would therefore *report* a deferral it cannot deliver.
      - **Nothing here can make a survivor useful either.** `orphan-adoption.ts` is
        adopt-or-kill and only kills — verdicts `killed|not-ours|dead|no-pid`
        (`orphan-adoption.ts:49-53`), no adopt arm, and `spawnResume` terminates the
        recorded pid before resuming (`orphan-adoption.ts:229`). A pane that survived a
        restart would be killed by the next boot.
      - **Both halves are milestone-1 work that lands first.** #538 moves the REPL into a
        herdr pane outside this process tree; #539 is explicitly "gating the shutdown kill"
        plus the adopt arm and the boot reconciliation pass. Building a drain here would be
        a mechanism #539 obsoletes, in a tree that forbids dual code paths.
- [ ] **Either way the owner is TOLD which happened. A deploy-caused death is never reported
      as a bare "child crashed" / "pooled child exited" — assert the stored reason names
      the deploy.**
      UNTICKED DELIBERATELY (round 14). As written this is an ABSOLUTE guarantee, and no
      mechanism inside this process can make it: both channels that carry the attribution
      — the durable registry record and the live sink — are stores this process does not
      control, and if BOTH fail the next boot has nothing that says "deploy" and honestly
      reports a dead pid. Measured rather than assumed: when the PRE-kill write fails there
      is no entry at all, so `detectReplWedged` returns `pid-dead` / `pooled child exited`
      — a path that exists independently of anything this change added, and which the box
      was ticked over. A ticked criterion that the code beneath it cannot falsify is the
      same defect as the `attributed` boolean, one layer up.

      WHAT IS GUARANTEED, and it is most of it:
      - A deploy-caused death is **never** reported as a bare crash **when either channel
        survives** — and they fail independently. The durable record is written before the
        kill and no longer depends on the journal entry surviving, so the confirmed outcome
        lands even if the pre-kill entry is gone — CARRYING THE PROCESS IDENTITY, not only
        the pid. The reconstructed entry used to carry the pid alone, which made this
        sentence false in the exact case it is about: the record survived and the next
        boot's probe could not tie the absent pid to our child, so it reported the death
        with the cause undetermined. A record that survives without the thing that makes it
        readable is not a surviving record, and the case now drives the real probe rather
        than handing the derived observation to the detector; the live report is attempted for every
        child; and a report whose durable record does NOT match it is attempted FIRST,
        because that live attempt is then its only channel.
      - Where the attribution cannot be established, the death is reported as **cause not
        established** — never as a crash the system did not observe, and never as a deploy
        it did not perform.
      - The residual is exactly: the registry row is lost or unwritable AND the sink fails
        or times out, for the same generation, in the same shutdown. Then the owner is told
        the launcher died, without the deploy being named.

      PINNED AS A SEQUENCE, not as wording: `__tests__/gateway-shutdown-kill.test.ts` →
      "what the owner gets when BOTH channels fail" drives durable-write-lost →
      live-report-lost → next boot and asserts the bare-crash outcome, with the complement
      that a surviving durable record still names the deploy with no live report at all.
      The rest of this criterion's machinery:  The dying gateway records the kill before it makes it
      (`gateway-shutdown-kill.ts` → `recordGatewayShutdownKill`, called synchronously from
      `pool.ts:shutdownAllPersistentRepls` and `spawn.ts:shutdownQuarantinedChildren`), and
      the live report it returns is delivered afterwards in a bounded phase
      (`deliverShutdownKillReports`) so no child's record or kill queues behind another
      child's sink. ~~`reportGatewayShutdownKill`, called from~~ SUPERSEDED (round 4): that
      function survives only as a single-child convenience for callers outside the shutdown
      walk; the walk itself must use the two-phase pair. The sink carries a `cause`
      discriminant, and both detectors read the generation-keyed kill record on the next
      boot — the record explaining a death the reader has independently confirmed (round 6),
      and the report's delivery, not its verdict, closing the crash edge (round 7). Checks: `open/wiring/__tests__/trident-child-crash-sink.test.ts`
      ("the stored failure_reason says deploy, and never says the child crashed" — asserts
      the real `code_trident_runs` row), `trident/tick-liveness.test.ts` T6,
      `__tests__/poison-eviction-live-work-guard.test.ts` ("a gateway shutdown reports its
      own kills as a deploy"), `__tests__/repl-supervision.test.ts` (#518, the next-boot
      watchdog path), `__tests__/gateway-shutdown-kill.test.ts`,
      `__tests__/launcher-liveness-attribution.test.ts`. And the backstop is exercised as a
      SEQUENCE rather than as an artifact — "the durable backstop actually backs up a failed
      report" drives sink-throws-at-shutdown → next boot → the attributed deploy report is
      delivered. Asserting that the marker exists never showed that it works.
- [x] **The two unexplained crashes (08-10 23:30, 08-11 06:04) have no checkout near them and
      are NOT closed by this fix. A change that claims them fails review.** Nothing in this
      change correlates a death with a deploy: attribution exists ONLY where the gateway
      wrote the marker itself, generation-scoped, AND only for a child observed ALIVE at the
      moment the shutdown reached it (`gateway-shutdown-kill.ts` →
      `sampleLivenessBeforeShutdownKill`). That last clause is load-bearing and was missing
      from the first cut: `kill()` is idempotent after exit (`pty-host.ts:46`), so teardown
      "kills" a child that died of a real fault moments earlier just as readily as a live
      one, and reporting THAT as a deploy is this item's own defect running backwards — the
      worse direction, because a fault absorbed into "a deploy did it" is a fault nobody
      investigates. A child already gone, or one whose liveness could not be read, is
      reported `cause: 'unknown'`: not a deploy, and not a crash verdict either.
      AND ON THE READ SIDE, the same question asked of the record rather than the sample:
      a record ATTRIBUTES a death, it does not ESTABLISH one — it is written before
      `kill()`, which can throw, so the reader confirms the death against the pid the
      entry carries and reports UNKNOWN when it cannot (`supervision.ts:1123-1163`). A
      revision that returned the attribution from the record alone would have crashed a
      run whose launcher was still alive. Checks:
      `__tests__/gateway-shutdown-kill.test.ts` ("only a child observed ALIVE is attributed
      to the shutdown", both arms) and `__tests__/poison-eviction-live-work-guard.test.ts`
      ("a child that was ALREADY DEAD when teardown arrived is not a deploy kill"). Every deploy case is paired with its
      complement, and the mutation run confirms the pair is real — making the deploy arm
      unconditional reddens
      `trident-child-crash-sink.test.ts` ("THE COMPLEMENT — a genuine crash with no deploy
      near it still reads as a crash", the 08-10/08-11 shape),
      `dead-repl-detector.test.ts`, `tick-liveness.test.ts` T6 and
      `launcher-liveness-attribution.test.ts`. A record naming a superseded generation
      cannot be read as describing the current child, because an entry names its own
      generation (`gatewayShutdownKillEntryFor`). ~~A stale marker naming a superseded
      generation is refused (`wasKilledByGatewayShutdown`), and `spawn.ts` clears both
      fields on a new spawn.~~ SUPERSEDED (round 5): the refusal guard and the
      clear-on-respawn were both DELETED when the marker became a per-generation list —
      the invariant they enforced twice is now a property of the shape, and the record
      MUST outlive its generation because a quarantined child depends on it. And a
      record never establishes a death on its own: the reader confirms the death against
      the pid the entry carries and uses the record only to explain it (round 6).
- [x] **This does not subsume #514 (a CRASHED run is never reaped), which asks what the row
      does AFTER a child dies. Fixing one must not be credited with the other.** #514's
      mechanism — the `onChildCrash` sink latching the runs a dead generation owned — is
      untouched: the same call, the same `crashRunningByLauncher`, the same reaping. This
      change adds only WHICH death it was (the `cause` field and the reason it composes).
      `trident-child-crash-sink.test.ts`'s `child-died` cases are #514's behaviour, still
      green and unmodified, and `repl-supervision.test.ts`'s "#514" case still asserts the
      bare `pooled child exited` detail.

## What was found not to be true

- The spec item's own framing — *"Restarting the instance's service SIGTERMs that REPL"* —
  understates it. The REPL does not die of signal propagation: the gateway's SIGTERM
  handler calls `shutdownAllPersistentRepls` (`gateway/index.ts:1052`), which walks the
  pool and calls `session.child.kill()` (`pool.ts:1034`) on every warm child. We kill it
  deliberately, which is precisely why the cause is knowable and can be recorded.
- A READ-BACK THAT CHECKS EXISTENCE CANNOT SUPPORT A CLAIM ABOUT CONTENT.
  `recordGatewayShutdownOutcome` keeps the FIRST entry for a generation (the kill happened
  once) and its read-back asked only whether an entry exists — so a second recording with a
  DIFFERENT observation returned success, and the caller then set `durablyRecorded` to the
  value it had ASKED FOR while the disk held the earlier one. That is `durablyRecorded`'s
  own defect by a second route: two rounds ago it was set before the disk changed, here
  without the disk changing at all. The recorder now returns WHAT IS ON DISK (the
  observation, or nothing), the caller carries that, and a disagreement is said out loud.
  Chosen over defining a strengthening lattice deliberately: the only strengthening this
  module needs is the post-kill confirmation, which `promoteGatewayShutdownObservation`
  already owns and already verifies — a second writer with a second rule for one field is
  what M36 caught in retention.
- THE UNDETERMINED STATE WAS HONOURED WHERE IT WAS SAMPLED AND DISCARDED WHERE IT WAS
  CONFIRMED. `sampleLivenessBeforeShutdownKill` catches a throwing liveness probe — that is
  why `could-not-sample` exists — and `confirmShutdownExits` then called the same
  `hasExited()` unprotected in three places, so a probe that threw REJECTED out of the
  confirmation phase and skipped everything after it, delivery included. Every child behind
  that watch lost both channels: the outcome the pending-spawn fix had just closed, by
  another route. A STATE THAT ABORTS ITS READER IS NOT REPRESENTED, ONLY SPELLED. Every
  confirmation read is now three-valued (`readHasExited`, and `readChildPid` for the pid
  read that precedes the kill), an unreadable probe stays undetermined and says so, and the
  drain continues.
- A WEDGED SPAWN COST EVERY LAUNCHER BEHIND IT ITS REPORT, which made the guarantee above
  hold only until the first pool entry that would not settle. `pool` stores the spawn
  PROMISE and inserts it before it resolves, and the shutdown walk awaited each entry in
  turn — so an unfinished spawn sat in front of every later child's MARKER AND KILL, at the
  ~40 s this function's own timing note measures against a 30 s `TimeoutStopSec`. Those
  children were then killed by the cgroup with NEITHER channel having reported, and the
  launcher that lost its report was the one whose gateway was already in trouble. Settled
  entries are now read synchronously (`Bun.peek.status`) and handled FIRST; the rest share
  one bounded wait, and anything still unsettled after it is named on stderr and left to
  the cgroup with a best-effort kill attached in case it lands later. Nothing durable is
  written for it: a pool entry that never resolved has no `child_generation` to attribute
  anything to, and never had a turn injected, so it hosts no detached workflow.
- THE RECOVERY PATH DROPPED THE ONE FIELD THAT MAKES RECOVERY POSSIBLE. `confirmShutdownKill`
  reconstructs a lost journal entry from the report and passed only the pid, so the
  surviving record could not be verified on the next boot and a confirmed deploy kill was
  reported as cause-undetermined — the guarantee above failing while every write reported
  success. The identity now travels on the report and into the authoritative upsert, and
  fills in an older entry that has none. The case that missed it handed
  `shutdownObserved: 'alive-and-killed'` straight to `detectReplWedged`: the fixture
  supplying the value whose derivation was the thing under test, which is how a test named
  for a sequence tested a step.
- AN HONEST VALUE WAS DELIVERED DOWN A CHANNEL THAT LIES, and it inverted this item's own
  subject. A child whose kill did not land was reported with `cause: 'unknown'` — accurate
  — to `onChildCrash`, whose production sink latches `crashRunningByLauncher` and marks
  every still-running run on that launcher `crashed`. The child that SURVIVED the deploy
  had its live build marked crashed by the change meant to protect it. A death sink is now
  told only where a death is ESTABLISHED (`alive-and-killed`, `already-gone`); an
  unestablished disposition goes to the notify-only seam and leaves the crash edge open.
  Pinned against the real store: the run stays `running`.
- ABANDONED IS NOT CANCELLED. A sink that timed out could still COMMIT a moment later,
  while the crash edge — keyed on our having waited — stayed open, so the next boot
  reported the same death over the top of a reason that had already landed. A late success
  now closes the edge; a late failure does not.
- EVERY BOUND IN THE SHUTDOWN WAS ALSO A FLOOR. `Promise.race([work, sleep(ms)])` settles
  when the work wins and leaves the timer running, and a pending timer keeps the runtime
  alive (measured: a race against `Bun.sleep(2000)` takes 2.01 s to exit). So a shutdown
  whose sinks answered instantly still burned the full per-sink budget inside a deadline
  systemd owns. Both waits are now cancellable handles released in a `finally`. The
  deterministic cases could not see it because they injected a wait that resolved at once,
  which made the BUDGET observable and the TIMER unobservable: A FAKE THAT REPLACES THE
  MECHANISM REMOVES THE PROPERTY THE MECHANISM HAS. Pinned in a subprocess, against elapsed
  process lifetime, with a leak control proving the measurement can fail.
- A PID IS AN IDENTIFIER, NOT A HANDLE. Kill entries stay eligible for four hours and the
  kernel reissues pids well inside that, while every reader confirmed a death against a
  stored NUMBER — so a reissued pid read as a live launcher (the multi-hour hang this item
  exists to remove, arriving through the process table), and an absent one was treated as
  evidence about our child when it could have been evidence about a stranger. Entries now
  carry the process identity the kernel maintains (`/proc/<pid>/stat` start ticks + boot
  id): a matching identity is ours, a differing one proves ours let the pid go, another
  boot is not comparable, and NO identity means the death may still be established but the
  cause may NOT be attributed.
- THE RETENTION BACKSTOP WAS THE PRIMARY RULE UNDER LOAD, and evicted inside the window it
  guaranteed. With more entries than the cap all genuinely young, it dropped the oldest
  still-live attribution — the loss this item exists to prevent, at the load that makes it
  likeliest. It does not need to evict: the age rule already bounds growth, so the count is
  now an ALARM that keeps everything and says so, and the constant is renamed for what it
  does.
- "IS IT DEAD" IS NOT "IS IT DEAD BECAUSE OF US" — the third position of this item's one
  sentence. `attributed` was derivable before the act; then a `kill()` that merely returned
  was read as a kill that worked; then an exit that happened anyway was read as our kill.
  Attribution now requires BOTH a delivered signal (carried on the watch, raised by the
  escalation) and an observed exit, so a child that died of something else while our signal
  was failing is undetermined rather than a deploy.
- A KILL THAT FAILED WAS STILL REPORTED AS A DEPLOY KILL — the purest form of the shape, and
  the only finding here that crashed a build that was still running. `attributed` was computed
  from the PRE-KILL liveness sample and consumed at delivery as though it described the
  OUTCOME; the shutdown queues the report, swallows a thrown `kill()`, and delivered the
  queued claim anyway. A pre-kill sample answers "was it alive"; the report asserts "we killed
  it". The fix is not to sample again but to make the claim UNDERIVABLE before the act:
  `attributed` is gone, the report carries the observation, and `alive-and-killed` is reachable
  only through `confirmShutdownKill` after `kill()` returns. Queued BEFORE the kill and
  confirmed after — stated deliberately, because queuing after would lose the record entirely
  if the process died mid-shutdown, and queuing before is only dangerous if the queued thing is
  a claim, so it is not one: the pre-kill value `alive-when-reached` is true when written and
  attributes nothing. The swallowed throw now records an undetermined disposition rather than
  letting the optimistic report stand. A second defect fell out of the same split:
  `recordGatewayShutdownKill` returned `null` with no sink wired, conflating "nothing to
  deliver" with "nothing to confirm", so a successful kill was never promoted for a
  sink-less substrate.
- THE PARSER PROMOTED WHAT IT DID NOT RECOGNISE. The entry validator checked `generation` and
  `at` only, and `observationOf` mapped every missing OR UNRECOGNISED `observed` value to
  `alive-and-killed` — the most definite answer available — so a forward-version entry, written
  by a newer build with no corruption at all, made a genuine crash report as a deploy. Round
  one's defect with the arrow reversed: an unrecognised enum member is the canonical unknown.
  `observed` is now required and validated where the entry is located; there is NO legacy arm,
  measured rather than assumed — `killed_by_gateway_shutdown` has zero occurrences on
  `origin/main`, so the container and the field ship together and no build has ever written an
  entry without it.
- THE RETENTION CAP ANSWERED "HOW MANY" WHEN THE QUESTION WAS "WHAT CAN STILL BE REFERENCED".
  Keeping the newest 16 entries was justified by trident's 2 h in-flight ceiling, but a time
  ceiling bounds DURATION while a count cap is driven by RESTART RATE and nothing ties them —
  an unmeasured assumption about the environment. Sixteen restarts inside the window evicted a
  generation that still owned a running build, losing its attribution: this item's own
  stranding, caused by the cap meant to be harmless. Retention is now age
  (`GATEWAY_SHUTDOWN_KILL_RETENTION_MS`, derived from `DEFAULT_MAX_INFLIGHT_MS` and doubled for
  margin) OR a live reference through `hostsLiveWork`, the same per-generation seam the pool
  consults before evicting a child that hosts live work. The count cap survives only as a
  logged backstop that can never evict a referenced entry — a property the first version of the
  fix broke in its own backstop and its own test caught.
- THE COMBINER MERGED TWO QUESTIONS ON ONE LATTICE, and stranded a run through the merge rather
  than the record. `dead`, `killed-by-gateway-shutdown` and `dead-cause-undetermined` all answer
  YES to "is it dead?" and differ only on WHY; the combiner treated only the first two as
  unanimous death, so two homes BOTH positively establishing death fell through to `unknown`, the
  tick ignored it and the run hung to timeout. Split into two lattices — liveness (any set drawn
  from the three dead verdicts is death; a single `alive` forbids reaping) and attribution (an
  explicit table where an attribution survives only if nothing contradicts it: a non-observation
  never overrides an observation; `dead` + `killed` is a real conflict, reported as disputed and
  logged rather than resolved by preferring an arm). That last row was decided only after
  establishing that plain `dead` is positive in both provenances and never arises from a failed
  look (`pool.ts:962` precedes `pool.ts:1008`, so the pool branch answers for a session that has
  not been through a shutdown; the registry branch answers only when a look found no entry). A
  merge function is not a reader of one entry but of two verdicts, which is why it sat outside
  the call-site audit — so each function now records WHICH QUESTION IT ASKS, and the matrix is
  the full cross-product rather than the rows that happened to be written.
- AUDITING FIELDS WAS THE WRONG DENOMINATOR — the readers are. Making the record three-valued
  fixed the writers and left `probeLauncherGenerationAlive`'s CURRENT-row branch asking only
  whether some entry carried a timestamp, so `already-gone` and `could-not-sample` both answered
  `killed-by-gateway-shutdown`: the owner told a deploy killed a build that died on its own,
  while the historical-entry branch four lines below classified correctly. Two readers of one
  field, one updated. Re-audited over CALL SITES: **eleven readers checked, one defective** —
  and two of the eleven ask about presence and are right to, because "does an entry exist" and
  "did my write land" are genuinely two-valued questions. `gatewayShutdownKillAt` is DELETED
  rather than fixed: `number | undefined` cannot express three observations, so the accessor's
  type invited the misread and would have invited it again. The suite could not have caught
  this — every undetermined case advanced `child_generation` first, so none reached the
  current-row branch.
- A TWO-VALUED DURABLE RECORD FOR A THREE-VALUED DOMAIN, which is the root the other
  findings on this item share. The record's vocabulary was *present* / *absent*; the domain is
  **killed-by-deploy**, **undetermined** and **ordinary crash**. So `undetermined` shared its
  representation with `ordinary crash` — the exact conflation this item exists to stop — and the
  next tick read it as the neighbour it resembled, mapping every non-deploy dead child to a
  confident `child-died`. The honest uncertainty could not survive to a retry because nothing
  recorded it. Fixed by persisting the classification: each entry carries what the shutdown
  OBSERVED (`alive-and-killed` / `already-gone` / `could-not-sample`), an entry is written for
  every outcome rather than only for a kill, and the cause mapping, the wedge verdict and the
  launcher-liveness verdict each gained the third value the state space needed. **`false` and
  `unknown` must not share a branch — and that applies to durable representations, not only to
  code paths.** A field that cannot express "I looked and could not tell" has that state read as
  whichever neighbour it resembles. Audited once across every durable field this change writes
  or reads rather than per finding: three of nine findings on this item were this same shape (the
  quarantined generation with nowhere to put its record; `child_crash_notified_at` conflating
  attributed with reported; this).
- THE CRASH EDGE WAS KEYED ON THE VERDICT INSTEAD OF ON THE DELIVERY, so an honest answer
  got overwritten by a confident one. The edge records that a death's report happened; an
  earlier revision closed it only when the report was an ATTRIBUTION, so a successfully
  delivered `cause: 'unknown'` left it open and the next watchdog tick reported the same
  death again as `cause: 'child-died'` — which `crashRunningByLauncher` writes over the
  tombstone unconditionally (`trident/store.ts:1367-1370`). `delivered` and `attributed` are
  different facts: telling the owner something is not telling the owner it was a deploy, and
  only the first closes the edge. The generalisation, because this is round 4's conflation
  arriving in a third state: `unknown` was not a possible value when that condition was
  written, so nothing about it was wrong until it was — **every new state must be checked
  against every field whose meaning was defined before that state existed.** The related
  last-writer-wins on the tombstone itself is filed separately (#648), with its reachability
  measured rather than asserted.
- TWO CORRECT FIXES LEFT A HOLE BETWEEN THEM, and it swallowed exactly the child that
  matters most. The row-scoping refusal (round 2) and the best-effort delivery phase (round 4)
  were each right, and together they meant a QUARANTINED generation — not the row's current
  one, because a replacement spawned over it — had its marker refused while its report was
  still queued. If that report failed, timed out or was skipped, delivery said the next boot
  would recover it from a marker that did not exist. A child is quarantined *because* it hosts
  running workflows, so that was the death likeliest to matter and the one with no record at
  all. Measured before choosing: marking at quarantine time is UNSOUND, not merely awkward —
  `sweepQuarantinedChildren` terminates a quarantined child on the ROUTINE drain
  (`spawn.ts:928-933`), which that marker would then attribute to a deploy. So the row now
  keeps a bounded LIST keyed by generation, and both readers look their own generation up.
  This is cheaper than it sounds and is not a database migration: the registry is a JSON file
  and its parser checks four fields and tolerates extras, so old and new builds interoperate
  in both directions. It also DELETES the round-2 refusal guard and the clear-on-respawn
  rather than adding machinery beside them — an entry names its own generation, so a stale
  entry cannot be read as describing the current child, which makes the invariant those
  guards defended a property of the shape. And it closes a hole that predates this item:
  `probeLauncherGenerationAlive` matched only `record.child_generation`
  (`supervision.ts:1059`), which a replacement spawn overwrites (`spawn.ts:735`), so a
  quarantined generation has never been locatable in the registry at all.
- THE REPORTING WORK WAS ON THE CRITICAL PATH OF THE KILLING WORK, and that is the root the
  other two findings shared. Shutdown runs against a deadline this process does not control
  (systemd SIGKILLs the cgroup at `TimeoutStopSec`, `gateway/index.ts:1026-1045`), and an
  earlier revision awaited the unrestricted `onChildCrash` promise between one child's kill
  and the next child's marker. One sink that never settled therefore took the deadline away
  from every child behind it, and each of those died unmarked and was reported on the next
  boot as a bare crash — this item's own purpose, defeated by this item's own code, and
  worse than the original defect because it took out every remaining child rather than one.
  Fixed by phase, not by patch: mark every child (cheap, local, durable), kill every child,
  then attempt the live reports with a bound per sink AND across the phase. A hung sink now
  costs a late report and nothing else, which is exactly what the marker was for. The
  constraint that makes this the rule rather than a one-off — *this code runs against a
  bounded external deadline and may get no further turn; everything in it must be either
  durable-and-cheap or bounded-and-optional* — is now written at the top of
  `gateway-shutdown-kill.ts`, because three consecutive defects shared that missing premise
  and a rule stated once is what stops the fourth.
- A "notified" tombstone written BEFORE the notification turned a transient failure into
  permanent silence, in the change whose whole subject is a death being reported wrongly.
  An earlier revision stamped `child_crash_notified_at` in the same patch as the attribution
  marker, i.e. before the sink ran. A throwing sink then left the edge CLOSED, so the next
  boot's watchdog skipped the death, the respawn cleared the marker, and the pull probe
  answered `unknown` for the old generation — the owner received no failure reason at all.
  Not a wrong one: none. The two are different facts and only one is knowable before the
  kill: the ATTRIBUTION (we are terminating a child observed alive) is; that the death was
  REPORTED is not. Split accordingly — marker before the kill, edge after the sink commits
  (`closeCrashReportEdge`) — a throwing sink now degrades into the behaviour worth having:
  the next boot reads the marker and delivers the ATTRIBUTED report, late, rather than a
  generic crash or nothing. The retry carries the attribution because the attribution is on
  disk. The rule generally: anywhere a marker means *this was reported*, the write belongs
  after the commit that makes it true.
- The marker being generation-scoped did not make it ROW-scoped, and an earlier revision of
  this change asserted the stronger claim. One teardown reaches two generations on one
  session key — the pooled child, and a QUARANTINED child that held the key before a fresh
  spawn took it over — and they share one registry row (`pool.ts:1008`, then `pool.ts:1094`).
  The later write replaced the earlier one, leaving the row naming one generation and the
  marker naming the other: attribution then fails AND `child_crash_notified_at` stays set,
  disabling the next boot's backstop in exactly the case it exists for (the direct sink
  throwing). ~~`markKilledByGatewayShutdown` now refuses to mark a generation the row does not
  currently name, which costs nothing — both consumers match on the row's CURRENT
  `child_generation`, so such a marker could never have been read back — and the refusal is
  reported rather than silent.~~ SUPERSEDED (round 5), and the refusal is exactly what the
  next finding was about: refusing left a QUARANTINED generation with no durable record at
  all. The row now keeps a per-generation list and permits every generation it killed; see
  the entry above. Kept here rather than rewritten because the refusal is how the next
  defect arrived.
- The site most certain to be hosting a live build reported NOTHING at all. A quarantined
  child is out of the pool *because* it still hosts running workflows, and
  `shutdownQuarantinedChildren` deleted its map entry before killing it, which made the
  `child.exited` hook `quarantineChild` installs return early (`spawn.ts:908`). Every
  deploy killed those silently.
