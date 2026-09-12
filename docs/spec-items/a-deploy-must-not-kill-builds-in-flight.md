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

## Acceptance

- [ ] **A deploy either drains/defers while a run is in flight, OR the workflow survives its
      launcher's restart. One of the two, chosen deliberately and pinned by a test.**
      CHOSEN: *the workflow survives its launcher's restart* — and it is NOT deliverable
      here, so this box stays open rather than being ticked against a check that does not
      exist. Why the choice is forced, established 2026-09-12:
      - **Drain/defer cannot work while the REPL is in the gateway's cgroup.** A deploy ends
        in `systemctl restart`; the unit is `KillMode=control-group`, so every descendant is
        SIGKILLed at `TimeoutStopSec` regardless of what our polite layer decides
        (`gateway/index.ts:1026-1038` says so in as many words). A `hostsLiveWork` gate on
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
- [x] **Either way the owner is TOLD which happened. A deploy-caused death is never reported
      as a bare "child crashed" / "pooled child exited" — assert the stored reason names
      the deploy.** The dying gateway records the kill before it makes it
      (`gateway-shutdown-kill.ts` → `reportGatewayShutdownKill`, called from
      `pool.ts:shutdownAllPersistentRepls` and `spawn.ts:shutdownQuarantinedChildren`), the
      sink carries a `cause` discriminant, and both detectors read a generation-scoped
      registry marker on the next boot. Checks: `open/wiring/__tests__/trident-child-crash-sink.test.ts`
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
      reported `cause: 'unknown'`: not a deploy, and not a crash verdict either. Checks:
      `__tests__/gateway-shutdown-kill.test.ts` ("only a child observed ALIVE is attributed
      to the shutdown", both arms) and `__tests__/poison-eviction-live-work-guard.test.ts`
      ("a child that was ALREADY DEAD when teardown arrived is not a deploy kill"). Every deploy case is paired with its
      complement, and the mutation run confirms the pair is real — making the deploy arm
      unconditional reddens
      `trident-child-crash-sink.test.ts` ("THE COMPLEMENT — a genuine crash with no deploy
      near it still reads as a crash", the 08-10/08-11 shape),
      `dead-repl-detector.test.ts`, `tick-liveness.test.ts` T6 and
      `launcher-liveness-attribution.test.ts`. A stale marker naming a superseded
      generation is refused (`wasKilledByGatewayShutdown`), and `spawn.ts` clears both
      fields on a new spawn.
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
  handler calls `shutdownAllPersistentRepls` (`gateway/index.ts:1045`), which walks the
  pool and calls `session.child.kill()` (`pool.ts:974`) on every warm child. We kill it
  deliberately, which is precisely why the cause is knowable and can be recorded.
- THE REPORTING WORK WAS ON THE CRITICAL PATH OF THE KILLING WORK, and that is the root the
  other two findings shared. Shutdown runs against a deadline this process does not control
  (systemd SIGKILLs the cgroup at `TimeoutStopSec`, `gateway/index.ts:1026-1038`), and an
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
  spawn took it over — and they share one registry row (`pool.ts:961`, then `pool.ts:985`).
  The later write replaced the earlier one, leaving the row naming one generation and the
  marker naming the other: attribution then fails AND `child_crash_notified_at` stays set,
  disabling the next boot's backstop in exactly the case it exists for (the direct sink
  throwing). `markKilledByGatewayShutdown` now refuses to mark a generation the row does not
  currently name, which costs nothing — both consumers match on the row's CURRENT
  `child_generation`, so such a marker could never have been read back — and the refusal is
  reported rather than silent.
- The site most certain to be hosting a live build reported NOTHING at all. A quarantined
  child is out of the pool *because* it still hosts running workflows, and
  `shutdownQuarantinedChildren` deleted its map entry before killing it, which made the
  `child.exited` hook `quarantineChild` installs return early (`spawn.ts:850`). Every
  deploy killed those silently.
