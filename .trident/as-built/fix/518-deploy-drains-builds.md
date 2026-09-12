## 2026-09-12 — a deploy that kills a build in flight says so, instead of reporting a crash

Spec item: `docs/spec-items/a-deploy-must-not-kill-builds-in-flight.md` (#518, P0, cutover
milestone 2).

### What was actually happening

A trident inner workflow is not its own process: it runs detached inside a warm `claude`
REPL the gateway owns (`cc-trident-fire-<owner>-<repo>`, composed in
`open/wiring/substrates.ts`). The spec item says a service restart "SIGTERMs that REPL",
which understates it — the gateway's own SIGTERM handler calls
`shutdownAllPersistentRepls` (`gateway/index.ts:1045`), which walks the pool and calls
`session.child.kill()` on every warm child (`pool.ts:957`). We kill it. Three of five
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
early (`spawn.ts:846`). Every deploy killed those silently.

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
  edge: `reportGatewayShutdownKill` stamps a generation-scoped marker on the durable REPL
  registry row and tells the crash sink with `cause: 'gateway-shutdown'`, awaited, before
  the kill. `markKilledByGatewayShutdown` returns whether the marker IS ON DISK, read back
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
no marker (an excuse on disk for a death we did not cause) and leaves `child_crash_notified_at`
OPEN, so the next boot still reports the fault honestly.

The residue is stated rather than papered over: `hasExited()` is a sample, so a child exiting
between the sample and the `kill()` still lands in the deploy bucket. That window is a
scheduler tick and it is irreducible with what a `PtyChild` exposes — `wasKilledByUs` answers
*who* signalled, not *when* it died, and our own `kill()` settles `exited` too, so no post-kill
read separates them. The remaining error is in the unsafe direction for microseconds, narrowed
from the whole teardown; it is named in the module header because a bounded misattribution
somebody can find beats an unbounded one nobody knows about.

**The marker was generation-scoped; the row it lives in was not.** One teardown reaches two
generations on one session key — the pooled child, and a quarantined child that held the key
before a fresh spawn took it over — and they share one registry row (`pool.ts:945`, then
`pool.ts:968`). The later write replaced the earlier one, so the row named one generation
beside a marker naming the other: attribution failed AND `child_crash_notified_at` stayed set,
disabling the next boot's backstop in exactly the case it exists for. `markKilledByGatewayShutdown`
now refuses a generation the row does not currently name — free, because both consumers match
on the row's CURRENT `child_generation`, so such a marker was never readable — and says so on
stderr rather than failing quietly.

The multi-generation test asserted only the emitted callbacks while reading as though it
covered the durable half; it now asserts the final registry row.

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

### The marker cannot outlive the child it describes

That is the mutation that would make this lie in the one direction the spec item forbids —
a genuine fault credited to a deploy — so it is guarded twice. `wasKilledByGatewayShutdown`
demands the marker name the row's CURRENT `child_generation`, and `spawn.ts` drops both
fields when it writes a new generation, exactly as it already dropped
`child_crash_notified_at`. Both guards have their own red mutation.

`child_crash_notified_at` is stamped by the marker write for a concrete reason:
`crashRunningByLauncher` upserts with
`ON CONFLICT(session_key) DO UPDATE SET failure_reason = excluded.failure_reason`, and
`saveIfActive` reads that tombstone back — so a late bare "pooled child exited" from the
next boot's watchdog would have laundered the deploy attribution away.

### Measured

26 mutations applied one at a time, each reverted after: **26 red, 0 survivors.** Every
deploy-arm mutation is paired with its inverse (make the arm unconditional), and each
inverse reddens a different test than the deletion does — the pairing is what makes the
negative acceptance criteria checks rather than prose.

Two entries in that table are worth their own sentence, because the mutation run found them
rather than confirming them:

- **M15** (delete the quarantine report) initially SURVIVED. The assertion said "at least one
  report, all of them deploys", which the *pooled* child's report satisfied on its own. It now
  names the quarantined generation explicitly.
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
