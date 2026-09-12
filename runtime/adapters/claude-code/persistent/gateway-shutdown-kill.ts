/**
 * gateway-shutdown-kill.ts — WE killed it. Record that, so nothing downstream
 * reports a deploy as a crash (#518).
 *
 * ── THE INCIDENT ─────────────────────────────────────────────────────────────
 * A trident inner workflow is not its own process: it runs DETACHED inside a warm
 * `claude` REPL the gateway owns (`cc-trident-fire-<owner>-<repo>`, composed in
 * `open/wiring/substrates.ts`). Restarting the instance's service therefore kills
 * every workflow in flight — and the kill is not even SIGTERM propagation, it is
 * OUR OWN `session.child.kill()` in `shutdownAllPersistentRepls` (`pool.ts`),
 * reached from the gateway's SIGTERM handler. Three of five recorded
 * `trident_launcher_crashes` landed 18-28 s after a deploy's vendor checkout, and
 * the 08-13 deploy rolled trident's own merge: a build that lands killed the
 * builds still running, at exactly the rate the pipeline succeeded.
 *
 * The detectors were working. The watchdog said `pid-dead` → `pooled child
 * exited`; the external liveness probe said `generation <g> is dead`. Both are
 * true sentences and both are the WRONG sentence: they describe a crash, and the
 * owner reading them cannot tell a deploy from a fault in his own build.
 *
 * ── WHY A DURABLE MARKER, NOT AN INFERENCE ───────────────────────────────────
 * Nothing outside the dying process can reconstruct this. A later reader sees a
 * dead pid and a gap in the log; "was there a deploy near this?" is a correlation
 * over timestamps, and #240 already refused to assert cause from correlation (the
 * crash sink reports the observed crash time and the gateway's boot time WITHOUT
 * claiming one caused the other). The one process that knows is the one that
 * pulled the trigger, and the only moment it knows is just before it does.
 *
 * So the shutdown path WRITES IT DOWN, into the durable REPL registry — the same
 * row that already survives a gateway restart to carry the resumable session id
 * and the child's pid. Two consumers read it back:
 *
 *   - the supervision watchdog on the NEXT boot, which finds the recorded pid
 *     dead and would otherwise fire the bare `pooled child exited` crash edge;
 *   - trident's external launcher-liveness probe, which would otherwise latch
 *     `inner workflow launcher crashed`.
 *
 * ── THE CONSTRAINT EVERYTHING HERE IS WRITTEN AGAINST ────────────────────────
 * READ THIS BEFORE ADDING ANYTHING TO THIS PATH.
 *
 * This code runs inside a shutdown with a BOUNDED EXTERNAL DEADLINE that this
 * process does not control, and it may get NO FURTHER TURN. The gateway's SIGTERM
 * handler calls `shutdownAllPersistentRepls`; systemd's `TimeoutStopSec` is 30 s and
 * the cgroup SIGKILL fires at the deadline whatever we are in the middle of
 * (`gateway/index.ts:1029-1038`). The database closes a few statements after we
 * return. Nothing here gets a retry, a second pass, or an apology.
 *
 * Therefore every step in this module is EITHER durable-and-cheap OR
 * bounded-and-optional, and the two are separated BY PHASE:
 *
 *   - DURABLE AND CHEAP — the registry marker. A local, synchronous write that
 *     records what we know before we act on it. It runs for every child, first.
 *   - BOUNDED AND OPTIONAL — the live `onChildCrash` report. It talks to a sink
 *     this module does not own and cannot vouch for, so it is attempted only after
 *     every child is marked and killed, and every wait on it is bounded.
 *
 * NOTHING UNBOUNDED MAY SIT ON THE CRITICAL PATH OF THE KILLING WORK. A sink that
 * never settles must cost a late report and nothing else — never another child's
 * marker, and never another child's kill. This rule is written here because the
 * three defects this module has already had were all the same mistake: the
 * reporting path was bolted onto a shutdown sequence whose deadline was never made
 * explicit. It claimed attribution for a child that was already dead; it wrote the
 * "reported" tombstone before the report; and it awaited an unrestricted sink
 * promise between one child's kill and the next, so one hung sink could take the
 * cgroup deadline away from every child behind it and leave them all to be reported
 * on the next boot as bare crashes — this module's own purpose, defeated by this
 * module. Each fix introduced the next, and the missing premise was the same.
 *
 * ── ONLY FOR A CHILD WE ACTUALLY KILLED ──────────────────────────────────────
 * `shutdownAllPersistentRepls` calls `kill()`, which is IDEMPOTENT AFTER EXIT
 * (`pty-host.ts`). So teardown "kills" a child that died of a genuine fault
 * moments earlier just as readily as a live one, and attributing that to the
 * deploy would be this module's own defect running backwards — a fault absorbed
 * into "a deploy did it" is a fault nobody investigates, which is worse for the
 * owner than the bare-crash report this change exists to replace.
 *
 * So liveness is SAMPLED FIRST ({@link sampleLivenessBeforeShutdownKill}) and
 * `'gateway-shutdown'` is claimed ONLY for a child observed alive. A child already
 * gone, or one whose liveness could not be sampled at all, is reported
 * `cause: 'unknown'` — never `'gateway-shutdown'`, and never `'child-died'`
 * either, because we did not observe what killed it. `deploy` and `cannot tell`
 * do not share a branch.
 *
 * THE RESIDUE, STATED RATHER THAN PAPERED OVER. `hasExited()` is a sample, so a
 * child that exits in the window between the sample and the `kill()` is still
 * bucketed `'gateway-shutdown'`. That window is a scheduler tick or two and it is
 * irreducible with the signals a `PtyChild` exposes: `wasKilledByUs` answers WHO
 * signalled, not WHEN it died, and our own `kill()` settles `exited` too, so no
 * post-kill read can separate the two. The remaining error therefore lands in the
 * UNSAFE direction (a fault read as a deploy) rather than the safe one, for a
 * window of microseconds — narrowed from the whole teardown, which is what the
 * unsampled version had. It is named here because a bounded misattribution
 * somebody can find beats an unbounded one nobody knows about.
 *
 * ── GENERATION-SCOPED, DELIBERATELY ──────────────────────────────────────────
 * The registry row is keyed by pool session key and OUTLIVES the child, so a
 * marker left on the row would go on excusing deaths forever: the next child's
 * genuine crash would be reported as a deploy. The marker therefore names the
 * exact `child_generation` it applies to and {@link wasKilledByGatewayShutdown}
 * asks whether the row's CURRENT `child_generation` has an entry, so an entry for a
 * superseded child answers false by construction — the mutation that would make the
 * reporting lie in the one direction the spec item forbids (a fault credited to a
 * deploy) is unrepresentable rather than guarded against.
 *
 * ── AND THE ROW HOLDS EVERY GENERATION IT KILLED, NOT JUST THE CURRENT ONE ───
 * The marker is per-generation; the ROW it lives in is per SESSION KEY, and one
 * teardown reaches two generations on one key — the pooled child, and a QUARANTINED
 * child that held the key until a replacement spawned over it.
 *
 * An earlier revision stored a single generation per row and REFUSED to mark any
 * other, which stopped the two from overwriting each other but left the quarantined
 * generation with nowhere durable to go: the row named only the newer pooled child,
 * so that death was neither delivered (if its live report failed) nor recoverable.
 * That is the worst place to lose one — a child is quarantined precisely BECAUSE it
 * still hosts running workflows.
 *
 * So the row keeps a bounded LIST keyed by generation
 * (`ReplRegistryRecord.killed_by_gateway_shutdown`). Every generation this shutdown
 * killed gets its own entry, and both readers look their generation up:
 * {@link wasKilledByGatewayShutdown} asks about the row's CURRENT child (the
 * watchdog's question) and `probeLauncherGenerationAlive` asks about an ARBITRARY
 * generation (trident's question, and the one a quarantined child needs).
 *
 * This also makes staleness structural rather than enforced. An entry names its own
 * generation, so it can never be read as describing a different child — which is why
 * the refusal guard and `spawn.ts`'s clear-on-respawn are both gone: the invariant
 * they defended is now a property of the shape.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 * It is not a drain, and it does not keep the workflow alive. Surviving the
 * restart is the herdr-host half of the acceptance (#538 moves the REPL out of
 * the gateway's process tree and cgroup; #539 gates this very kill and adds the
 * adopt arm `orphan-adoption.ts` has never had). Until then the build dies — and
 * this module is why the owner is TOLD that a deploy killed it.
 */

import {
  GATEWAY_SHUTDOWN_KILL_ALARM_COUNT,
  GATEWAY_SHUTDOWN_KILL_RETENTION_MS,
  getRecord,
  patchRecord,
  type GatewayShutdownKillEntry,
  type GatewayShutdownObservation,
  type ReplRegistryRecord,
} from './repl-registry.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import { readProcessIdentity, type ProcessIdentity } from './process-identity.ts'
import type { PersistentReplSubstrateOptions } from './types.ts'

/**
 * What could be established about a child at the moment the shutdown reached it.
 *
 *   - `'alive'`           — it had not exited; the shutdown's `kill()` is the cause.
 *   - `'already-gone'`    — it was already gone; the shutdown did NOT kill it, and
 *                           we did not observe what did.
 *   - `'could-not-sample'`— the liveness probe itself failed. Distinct from
 *                           `'already-gone'`, because "it was dead" and "I could
 *                           not look" are different facts and only one of them is
 *                           an observation.
 */
export type ShutdownLivenessSample = 'alive' | 'already-gone' | 'could-not-sample'

/**
 * Sample a child's liveness before the shutdown kills it. Pure over the injected
 * probe so both arms are directly testable.
 *
 * A THROW IS NOT A DEATH AND NOT A LIFE. `ReplSession.hasChildExited` treats a
 * session with no attached child as exited, which is right for this question (we
 * cannot have killed a child that was never there), but a probe that throws has
 * established nothing and says so.
 */
export function sampleLivenessBeforeShutdownKill(hasExited: () => boolean): ShutdownLivenessSample {
  try {
    return hasExited() ? 'already-gone' : 'alive'
  } catch {
    return 'could-not-sample'
  }
}

/**
 * Did a gateway shutdown deliberately terminate the child this row CURRENTLY
 * describes? True only when the marker names the row's own `child_generation` —
 * a marker for a superseded generation is stale and answers false, so a fresh
 * child's genuine crash is never excused as a deploy.
 */
export function wasKilledByGatewayShutdown(record: ReplRegistryRecord | undefined): boolean {
  const current = record?.child_generation
  if (typeof current !== 'string' || current.length === 0) return false
  return observationOf(gatewayShutdownKillEntryFor(record, current)) === 'alive-and-killed'
}

/**
 * What the shutdown observed about this entry's generation. An entry with no
 * `observed` field predates it and can only have come from the kill path, which is the
 * one path that wrote an entry at all — so that is what it is read as.
 */
export function observationOf(
  entry: GatewayShutdownKillEntry | undefined,
): GatewayShutdownObservation | undefined {
  // A narrow accessor over an ALREADY-VALIDATED entry: `gatewayShutdownKillEntryFor`
  // refuses an entry whose `observed` is absent or unrecognised, so anything that gets
  // here carries one of the three values. It is re-checked rather than asserted, because
  // a caller could hand in an unvalidated entry and this must not become the place that
  // promotes a bad value.
  //
  // AN UNRECOGNISED MEMBER IS THE CANONICAL UNKNOWN, and an earlier revision mapped it —
  // and a missing value — to `'alive-and-killed'`, the MOST definite answer available.
  // A forward-version entry (written by a newer build than the one reading it) reached
  // that without any corruption, and a genuine crash was then attributed to a deploy:
  // the round-one defect with the arrow reversed.
  return isObservation(entry?.observed) ? entry.observed : undefined
}

/** Is this one of the three observations? Rows survive upgrades and are not a trusted
 *  type boundary, so the check is a whitelist, never a cast. */
function isObservation(value: unknown): value is GatewayShutdownObservation {
  return (
    value === 'alive-and-killed' ||
    value === 'alive-when-reached' ||
    value === 'already-gone' ||
    value === 'could-not-sample'
  )
}

/**
 * The entry for an ARBITRARY generation on this row, or undefined.
 *
 * The generation is matched exactly and must be non-empty: two empty strings are
 * equal, so a bare comparison would read a half-written row as a deploy kill.
 */
export function gatewayShutdownKillEntryFor(
  record: ReplRegistryRecord | undefined,
  generation: string,
): GatewayShutdownKillEntry | undefined {
  if (record === undefined || typeof generation !== 'string' || generation.length === 0) return undefined
  const entries = record.killed_by_gateway_shutdown
  if (!Array.isArray(entries)) return undefined
  // Rows survive upgrades and are not a trusted type boundary — a malformed entry
  // must not become positive evidence that we killed something.
  return entries.find(
    (e) =>
      e !== null &&
      typeof e === 'object' &&
      e.generation === generation &&
      typeof e.at === 'number' &&
      Number.isFinite(e.at) &&
      // `observed` IS REQUIRED, and an invalid present value is refused rather than
      // promoted. An entry that cannot say what was observed is not evidence of
      // anything — it is certainly not evidence that WE killed the child, which is the
      // reading an earlier revision gave it.
      //
      // NO LEGACY ARM, and that is a measured decision rather than an oversight:
      // `killed_by_gateway_shutdown` has zero occurrences on `origin/main`, so the
      // container and this field ship in the SAME unmerged change and no build has ever
      // written an entry without it. A compat arm here would cover nothing while
      // silently promoting every corrupt and forward-version entry.
      isObservation(e.observed),
  )
}

/*
 * `gatewayShutdownKillAt` DELETED (#518, round 9). It returned `number | undefined`,
 * and that type cannot express three observations — so its one caller asked "is there
 * a timestamp?" and read `already-gone` and `could-not-sample` as a deploy kill, telling
 * the owner a deploy had killed a build that died on its own. The accessor's SHAPE was
 * the defect, not just the caller: an accessor that collapses a three-valued domain into
 * presence-or-absence invites exactly that read from the next caller too. Nothing in
 * production needed the timestamp, so it is gone rather than fixed; classify through
 * {@link observationOf}, and read `.at` off the entry if a timestamp is ever wanted.
 */

/**
 * The sentence every consumer of this edge uses, authored ONCE. It says what
 * happened (the owning gateway shut down and terminated the REPL), names the
 * operational act that does it (a restart or a deploy), and says what it was NOT
 * (a crash) — because the whole defect this fixes is a true sentence read as the
 * wrong one.
 */
export function gatewayShutdownKillDetail(at: number): string {
  return (
    `terminated by its own gateway shutting down at ${new Date(at).toISOString()} ` +
    `(a service restart or a deploy) — NOT a crash of the child or the build`
  )
}

/**
 * The sentence for a child the shutdown reached but did not demonstrably kill. It
 * states what was observed and refuses the two confident readings either side of
 * it: this is not claimed as a deploy, and it is not claimed as a fault.
 */
export function undeterminedShutdownDetail(observed: GatewayShutdownObservation, at: number): string {
  const when = new Date(at).toISOString()
  switch (observed) {
    case 'alive-when-reached':
      return (
        `it was alive when the gateway shut down at ${when} and the shutdown COULD NOT TERMINATE it, ` +
        `so whether the shutdown ended it is UNDETERMINED — not established as a deploy, not established as a fault`
      )
    case 'could-not-sample':
      return (
        `its launcher's liveness could not be read when the gateway shut down at ${when}, ` +
        `so whether the shutdown ended it is UNDETERMINED — not established as a deploy, not established as a fault`
      )
    case 'already-gone':
      return (
        `its launcher was ALREADY gone when the gateway shut down at ${when}, so the shutdown did not end it; ` +
        `what did is UNDETERMINED — not established as a deploy, not established as a fault`
      )
    case 'alive-and-killed':
      // Not reachable from the undetermined arm; kept total rather than defaulted, so a
      // later member cannot fall silently into someone else's sentence.
      return gatewayShutdownKillDetail(at)
  }
}

/**
 * Record the deliberate kill on the durable registry row, BEFORE the child is
 * killed — after it, the process may not get another scheduler turn.
 *
 * It records the CAUSE only. Closing the crash-report edge is
 * {@link closeCrashReportEdge}'s job and happens after the sink commits — see the
 * note there for the silence that ordering prevents.
 *
 * A second report from the next boot is no longer a hazard worth pre-empting, and
 * that is a consequence of this marker rather than of the edge: the watchdog reads
 * the marker, so its report carries the SAME deploy attribution. Where it once would
 * have overwritten the reason with a bare "pooled child exited" through
 * `crashRunningByLauncher`'s `ON CONFLICT … DO UPDATE SET failure_reason`
 * (`trident/store.ts`), it now rewrites the identical sentence.
 *
 * Best-effort by construction: a registry write must never brick a shutdown.
 *
 * Returns whether the marker IS ON DISK, read back through the same predicate the
 * consumers use — not whether the write call returned. `patchRecord` is a silent
 * no-op for a session key with no row (`if (prev)`), and `withRegistry` deliberately
 * skips the save on a whole-file read error, so "the call did not throw" is not
 * evidence that anything was recorded. A no-op that reported success here would put
 * the next boot back to reporting our own kill as a crash, with nothing saying so.
 */
/**
 * Drop the entries that can no longer be referenced, and ONLY those.
 *
 * The question this function asks is "what can still be referenced" — which is why it is
 * not answered by counting. An entry is kept when EITHER it is inside the retention
 * window (nothing older can be asked about, bounded by trident's in-flight ceiling) OR a
 * live run still references its generation. `stillReferenced` is the same per-generation
 * seam the pool already consults before evicting a child that hosts live work: the
 * identical question, one layer down.
 *
 * ABSENT `stillReferenced` MEANS "I CANNOT TELL", NOT "NOTHING IS REFERENCED". An unwired
 * probe therefore protects nothing extra but is never taken as permission to evict inside
 * the window — age alone governs, which is the conservative reading.
 *
 * The count cap is a backstop and can only take entries this rule has already released.
 * If everything is still referenced or still young, the row grows and says so, because a
 * large row is a smaller harm than a build with no failure reason.
 */
export function pruneGatewayShutdownKills(
  entries: readonly GatewayShutdownKillEntry[],
  now: number,
  stillReferenced?: (generation: string) => boolean,
): GatewayShutdownKillEntry[] {
  const referenced = (e: GatewayShutdownKillEntry): boolean => {
    try {
      return stillReferenced?.(e.generation) === true
    } catch {
      // A throwing probe has established nothing, and is never taken as a reference.
      return false
    }
  }
  const young = (e: GatewayShutdownKillEntry): boolean =>
    typeof e.at === 'number' && Number.isFinite(e.at) && now - e.at < GATEWAY_SHUTDOWN_KILL_RETENTION_MS

  const keep = entries.filter((e) => young(e) || referenced(e))
  // NOTHING IS EVICTED FOR CROSSING THE ALARM THRESHOLD. An earlier revision sliced the
  // row down to it, which contradicted this function's own contract: with more entries
  // than the threshold all genuinely YOUNG, the "backstop" became the primary rule and
  // dropped the oldest still-live attribution — the loss this mechanism exists to prevent,
  // under the load that makes it likeliest. The age rule already bounds growth (everything
  // outside the window is released), so crossing the threshold is a thing to SAY, not a
  // reason to discard evidence.
  if (keep.length > GATEWAY_SHUTDOWN_KILL_ALARM_COUNT) {
    process.stderr.write(
      `[repl] gateway-shutdown kill history for one session key holds ${keep.length} entries still inside the ` +
        `retention window (alarm threshold ${GATEWAY_SHUTDOWN_KILL_ALARM_COUNT}) — KEEPING them all, because ` +
        `dropping one loses a build's failure reason; something is restarting this session key pathologically\n`,
    )
  }
  return keep
}

/**
 * THE ONLY ROUTE TO A DEPLOY ATTRIBUTION, and it runs AFTER `kill()` returns.
 *
 * A report of a kill must not be DERIVABLE before the kill — not merely unwritten. So
 * the pre-kill record says `alive-when-reached`, which is true when written and
 * attributes nothing, and this promotes it to `alive-and-killed` only once the act has
 * actually happened. A kill that threw establishes nothing and leaves the record where
 * it was, which is the honest "cause not established" rather than a claim nothing
 * performed.
 *
 * Mutates the report in place because the delivery phase reads it later, and patches the
 * durable row so the next boot sees the same conclusion as the live sink. Both writes
 * are cheap and local, which is what the shutdown's deadline allows.
 */
export function confirmShutdownKill(
  report: PendingShutdownKillReport | null,
  outcome: { killed: boolean },
): void {
  if (report === null) return
  if (report.observed !== 'alive-when-reached') return
  if (!outcome.killed) {
    // Shutdown continues — that part was always right — but the disposition of THIS
    // child is now explicitly unknown rather than left to an earlier optimistic claim.
    process.stderr.write(
      `[repl] gateway shutdown could not terminate generation=${report.childGeneration.slice(0, 8)} ` +
        `— its disposition is UNDETERMINED and it is NOT reported as a deploy kill\n`,
    )
    return
  }
  report.observed = 'alive-and-killed'
  if (report.options.replRegistryPath === undefined) return
  // THE DISK CLAIM IS RE-ESTABLISHED, not assumed to have followed. A promotion that
  // cannot fail visibly cannot support a promise about recovery.
  const promoted = promoteGatewayShutdownObservation(
    report.options.replRegistryPath,
    report.sessionKey,
    report.childGeneration,
    'alive-and-killed',
    report.at,
    report.pid,
    // The same reference probe the record path uses, so both writes ask the same question.
    report.options.hostsLiveWork === undefined
      ? undefined
      : (generation) => {
          try {
            return report.options.hostsLiveWork!(generation) > 0
          } catch {
            return false
          }
        },
  )
  if (!promoted) {
    process.stderr.write(
      `[repl] gateway shutdown could not promote the durable record for generation=` +
        `${report.childGeneration.slice(0, 8)} to a confirmed kill — the row still says ` +
        `"${report.durablyRecorded ?? 'nothing'}", so a lost live report is recovered as ` +
        `cause-not-established rather than as a deploy\n`,
    )
    return
  }
  report.durablyRecorded = 'alive-and-killed'
}

/** Move an existing entry's observation forward. Only ever called with the post-kill
 *  conclusion; a missing entry is not invented. */
function promoteGatewayShutdownObservation(
  registryPath: string,
  sessionKey: string,
  childGeneration: string,
  observed: GatewayShutdownObservation,
  at: number,
  pid?: number,
  stillReferenced?: (generation: string) => boolean,
): boolean {
  try {
    const record = getRecord(registryPath, sessionKey)
    if (record === undefined) return false
    const prior = Array.isArray(record.killed_by_gateway_shutdown) ? record.killed_by_gateway_shutdown : []
    // AN INDEPENDENT WRITE OF THE CONFIRMED OUTCOME, not a map over an entry that must
    // still be there. An earlier revision bailed when the pre-kill entry was missing or
    // the array was malformed, which made the confirmed outcome depend on the PROVISIONAL
    // one surviving — two ways to lose a record where the act only justifies one. The
    // pre-kill entry is a journal; this is the authoritative write, and it stands on its
    // own.
    const confirmed: GatewayShutdownKillEntry = {
      generation: childGeneration,
      at,
      observed,
      ...(typeof pid === 'number' && pid > 0 ? { pid } : {}),
    }
    const seen = prior.some((e) => e?.generation === childGeneration)
    // ONE RETENTION RULE, applied wherever entries are written. The append branch used to
    // apply only the count cap, so a confirmed write could resurrect an entry retention
    // had just released — two writes obeying two rules, which is also what let a mutation
    // that collapsed retention survive: the second write put back what the first dropped.
    const entries = seen
      ? prior.map((e) => (e?.generation === childGeneration ? { ...e, observed } : e))
      : pruneGatewayShutdownKills([...prior, confirmed], at, stillReferenced)
    patchRecord(registryPath, sessionKey, { killed_by_gateway_shutdown: entries })
    // READ BACK, because `patchRecord` is a silent no-op for an absent row and
    // `withRegistry` skips the save on a whole-file read error. "The call did not throw"
    // is not evidence the write landed.
    return observationOf(gatewayShutdownKillEntryFor(getRecord(registryPath, sessionKey), childGeneration)) === observed
  } catch {
    /* a registry write must never brick a shutdown */
    return false
  }
}

/** A signalled child whose exit has not yet been confirmed. The handle is narrowed to
 *  what confirmation needs, so this module still knows nothing about a PTY. */
export interface ShutdownExitWatch {
  report: PendingShutdownKillReport
  child: { readonly exited: Promise<number | null>; hasExited: () => boolean; kill: (signal?: never) => void }
  /**
   * Whether OUR termination signal was actually delivered — set by the caller for the
   * initial signal, and raised here if the SIGKILL escalation succeeds.
   *
   * ATTRIBUTION NEEDS "DEAD BECAUSE OF US", AND `hasExited()` ONLY ANSWERS "DEAD". This is
   * the third position of one defect on this item: the attribution was first derivable
   * before the act, then read from a `kill()` that merely returned, and then from an exit
   * that may have happened anyway. Each fix moved the evidence closer to the act and none
   * recorded whether the act SUCCEEDED. A child whose signal failed and which then died on
   * its own is dead — and not by us, so it is undetermined, never a deploy kill.
   */
  signalDelivered: boolean
}

/**
 * A bounded wait THAT CAN BE TAKEN BACK.
 *
 * `Promise.race([work, sleep(ms)])` settles as soon as the work wins — and leaves the
 * timer running. A pending timer keeps the runtime alive (measured: `Promise.race([
 * Promise.resolve(), Bun.sleep(2000)])` takes 2.01 s to exit), so every bound in this
 * module was also a FLOOR: a shutdown whose sinks answered instantly still sat out the
 * full budget, inside a deadline owned by systemd rather than by us. RACING IS NOT
 * CANCELLING.
 *
 * The injectable seam has the same shape for a reason. The previous tests replaced the
 * wait with an instantly-resolving function, which made the requested budget observable
 * and the TIMER unobservable — a fake that replaces the mechanism removes the property
 * the mechanism has. A fake `BoundedWait` still has a `cancel` that a test can watch.
 */
export interface BoundedWait {
  /** Resolves when the bound is reached. */
  expired: Promise<void>
  /** Releases the underlying timer. Idempotent, and safe after expiry. */
  cancel: () => void
}

/** How a bounded wait is made. Production uses {@link cancellableWait}. */
export type WaitFactory = (ms: number) => BoundedWait

export function cancellableWait(ms: number): BoundedWait {
  let id: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<void>((resolve) => {
    id = setTimeout(resolve, ms)
  })
  return {
    expired,
    cancel: () => {
      if (id !== undefined) clearTimeout(id)
      id = undefined
    },
  }
}

/** How long every signalled child together gets to exit before the escalation, and
 *  again after it. Mirrors `CHILD_KILL_GRACE_MS`, which is what the tree's own safe
 *  termination helper waits — shared across the phase rather than spent per child,
 *  because the shutdown's deadline is shared too. */
export const SHUTDOWN_EXIT_GRACE_MS = 2_000

/**
 * PHASE 2b — establish which signalled children actually died, and confirm each report
 * from THAT rather than from the signal returning.
 *
 * `PtyChild.kill()` only REQUESTS termination and returns void; termination itself shows
 * up on `exited` / `hasExited()`. An earlier revision confirmed a kill as soon as signal
 * delivery did not throw, so a child that ignores or delays SIGTERM — the case that
 * exists in production, because SIGTERM is a request — was recorded as
 * `alive-and-killed` and its build was marked crashed while it was still running.
 * "The signal did not throw" is the absence of one failure mode, not confirmation.
 *
 * Follows the escalation the tree's own `terminateChild` uses (await, then SIGKILL, then
 * await again) but spends the grace ONCE for the whole phase instead of per child: every
 * child has already been signalled, so their exits overlap, and the shutdown's deadline
 * is shared. A child still alive after the escalation records an UNDETERMINED
 * disposition — never a kill.
 */
export async function confirmShutdownExits(
  watches: readonly ShutdownExitWatch[],
  opts: { graceMs?: number; wait?: WaitFactory } = {},
): Promise<void> {
  if (watches.length === 0) return
  const graceMs = opts.graceMs ?? SHUTDOWN_EXIT_GRACE_MS
  const wait = opts.wait ?? cancellableWait
  const settle = async (): Promise<void> => {
    const pending = watches.filter((w) => !w.child.hasExited())
    if (pending.length === 0) return
    // CANCELLED WHEN THE EXITS WIN. The grace is a ceiling on how long we wait for
    // children that are slow to die, not a period the teardown must serve even when
    // every child is already gone.
    const bound = wait(graceMs)
    try {
      await Promise.race([
        Promise.all(pending.map((w) => w.child.exited.catch(() => undefined))),
        bound.expired,
      ]).catch(() => undefined)
    } finally {
      bound.cancel()
    }
  }
  await settle()
  for (const w of watches) {
    if (w.child.hasExited()) continue
    try {
      w.child.kill('SIGKILL' as never)
      // The escalation landed, so from here a death IS ours to claim.
      w.signalDelivered = true
    } catch {
      /* already gone, or unsignallable — the recheck below decides either way */
    }
  }
  await settle()
  for (const w of watches) {
    // BOTH are required. Exited without a delivered signal means it died of something
    // else while we were failing to signal it: dead, and not by us.
    confirmShutdownKill(w.report, { killed: w.signalDelivered && w.child.hasExited() })
  }
}

export function recordGatewayShutdownOutcome(
  registryPath: string,
  sessionKey: string,
  childGeneration: string,
  at: number,
  observed: GatewayShutdownObservation,
  pid?: number,
  stillReferenced?: (generation: string) => boolean,
  /** WHICH PROCESS that pid is, sampled while it is still alive. Absent where the
   *  kernel cannot be asked; the entry then records a pid a later reader may not
   *  attribute a death to. */
  identity?: ProcessIdentity,
): boolean {
  if (typeof childGeneration !== 'string' || childGeneration.length === 0) return false
  try {
    // APPEND, KEYED BY GENERATION. Any generation this session key had killed gets an
    // entry, including a QUARANTINED one the row no longer names — that child is the
    // likeliest of all to be hosting live work, and a single-slot marker had nowhere
    // to put it. Entries are idempotent per generation (a re-mark keeps the first
    // timestamp: the kill happened once) and bounded to the newest
    // GATEWAY_SHUTDOWN_KILL_ALARM_COUNT.
    const existing = getRecord(registryPath, sessionKey)
    if (existing === undefined) return false
    const prior = Array.isArray(existing.killed_by_gateway_shutdown) ? existing.killed_by_gateway_shutdown : []
    const entries =
      gatewayShutdownKillEntryFor(existing, childGeneration) !== undefined
        ? prior
        : pruneGatewayShutdownKills(
            [
              ...prior,
              // The pid travels WITH the entry so a later reader can confirm the death
              // against the process table rather than trusting this record. See the
              // field's docblock: writing the entry attributes a death, it does not
              // establish one.
              {
                generation: childGeneration,
                at,
                observed,
                ...(typeof pid === 'number' && pid > 0 ? { pid } : {}),
                // AND WHICH PROCESS THAT PID IS. Stored beside the pid, never instead of
                // it: the pid is how a reader looks, the identity is how it knows the
                // look was about our child rather than about whatever inherited the
                // number in the four hours this entry stays eligible.
                ...(identity !== undefined ? { identity } : {}),
              },
            ],
            at,
            stillReferenced,
          )
    patchRecord(registryPath, sessionKey, { killed_by_gateway_shutdown: entries })
    return gatewayShutdownKillEntryFor(getRecord(registryPath, sessionKey), childGeneration) !== undefined
  } catch {
    return false
  }
}

/**
 * Close this pid edge's crash report — `child_crash_notified_at`, the field the
 * supervision watchdog reads to decide it has nothing left to say about this death.
 *
 * CALLED ONLY AFTER A SINK COMMIT, NEVER BEFORE. An earlier revision wrote it in the
 * same patch as the attribution marker above, i.e. before the report it claims had
 * happened. That records an INTENTION AS AN OUTCOME, and it converted a transient
 * sink failure into permanent silence: the next boot's watchdog skipped the edge
 * because the field was set, then respawned the child, and the respawn cleared the
 * marker — so the pull probe answered `unknown` for the old generation and the owner
 * received NO failure reason at all. Not a wrong reason: none. In a change that
 * exists because a deploy-caused death surfaced as a bare crash, that is the same
 * defect one step further on.
 *
 * The same reasoning already guarded the unattributed path, where leaving this field
 * OPEN is what lets the next boot report the death we declined to claim. It belongs
 * on both branches: a "notified" tombstone is written after the notification.
 *
 * Generation-scoped for the same reason the marker is — the row outlives the child,
 * and closing the edge of a generation the row has moved past would silence a report
 * nobody has made.
 */
export function closeCrashReportEdge(
  registryPath: string,
  sessionKey: string,
  childGeneration: string,
  at: number,
): boolean {
  try {
    if (getRecord(registryPath, sessionKey)?.child_generation !== childGeneration) return false
    patchRecord(registryPath, sessionKey, { child_crash_notified_at: at })
    return getRecord(registryPath, sessionKey)?.child_crash_notified_at === at
  } catch {
    return false
  }
}

/** How long ONE sink call may hold the shutdown. */
export const SHUTDOWN_REPORT_PER_SINK_MS = 2_000
/** How long the WHOLE reporting phase may hold the shutdown, across every child.
 *  Bounded as a phase and not only per child, because N hung sinks must not cost
 *  N × the per-sink bound out of a deadline shared with the rest of the teardown. */
export const SHUTDOWN_REPORT_PHASE_BUDGET_MS = 5_000

/**
 * A live report that is OWED, once the child it describes has been marked and killed.
 *
 * It exists as a value because the reporting is deliberately NOT done where it is
 * decided: deciding is cheap and local, reporting talks to a sink this module does
 * not own. See the constraint at the top of this file.
 */
export interface PendingShutdownKillReport {
  options: PersistentReplSubstrateOptions
  sessionKey: string
  childGeneration: string
  at: number
  /** The dead child's OS pid, recorded so the death can be confirmed later. */
  pid?: number
  /**
   * What the shutdown has established SO FAR. Starts at the pre-kill observation and is
   * promoted to `'alive-and-killed'` by {@link confirmShutdownKill} once `kill()` has
   * returned — never before.
   *
   * THERE IS NO `attributed` BOOLEAN, deliberately. One used to be computed from the
   * PRE-KILL liveness sample and consumed at delivery as though it described the
   * OUTCOME, so a kill that threw still published `cause: 'gateway-shutdown'` and the
   * sink crashed a build that was still running. A pre-kill sample answers "was it
   * alive"; the report asserts "we killed it". Deriving the cause from this field at
   * delivery makes the claim underivable before the act, rather than merely unwritten.
   */
  observed: GatewayShutdownObservation
  liveness: ShutdownLivenessSample
  /**
   * WHAT IS ON DISK for this generation, or `null` when nothing is — not "did a write
   * happen". The delivery phase tells the operator whether the next boot can recover an
   * undelivered report, and that promise is only as good as the record behind it.
   *
   * IT IS RECOMPUTED WHENEVER THE DISK CHANGES, which is the point. It used to be a
   * boolean set after persisting the PRE-KILL observation; `confirmShutdownKill` then
   * promoted the in-memory report to `alive-and-killed` with a disk write that returned
   * no status and swallowed every failure. So a failed promotion plus a timed-out
   * delivery told the operator the next boot would recover the report, while the next
   * boot would read `alive-when-reached` and report the cause undetermined. A claim
   * about what is on disk has to be re-established when what is on disk changes — the
   * same reason `attributed` was deleted.
   */
  durablyRecorded: GatewayShutdownObservation | null
}

/**
 * PHASE 1 — record what we know, durably and synchronously, and return the live
 * report that is now owed.
 *
 * Everything expensive is deliberately left to {@link deliverShutdownKillReports}.
 * This function does not await anything: it must be safe to run for every child
 * before any of them is killed, and it must not be able to consume the shutdown's
 * deadline on behalf of a child that has not been reached yet.
 *
 * Always returns the report, even with no sink wired: the return value is what the kill's
 * outcome is attached to, and that is needed whether or not anyone is listening. The
 * delivery phase skips a report with no sink.
 */
export function recordGatewayShutdownKill(
  options: PersistentReplSubstrateOptions,
  sessionKey: string,
  childGeneration: string,
  at: number,
  liveness: ShutdownLivenessSample,
  pid?: number,
  /** Seam for tests only. Production samples the kernel here, PRE-KILL, because that is
   *  the last moment the process is certainly still the one we are about to kill. */
  readIdentity: (pid: number) => ProcessIdentity | undefined = readProcessIdentity,
): PendingShutdownKillReport {
  // ATTRIBUTION FOLLOWS THE OBSERVATION, not the call site. Only a child observed
  // ALIVE was killed by this shutdown; anything else is reported as undetermined.
  // THE PRE-KILL OBSERVATION, and it does not assert the kill. `'alive-and-killed'` is
  // reachable only from `confirmShutdownKill`, after `kill()` returns.
  const observed: GatewayShutdownObservation =
    liveness === 'alive' ? 'alive-when-reached' : liveness === 'already-gone' ? 'already-gone' : 'could-not-sample'
  // SAMPLED BEFORE THE KILL, for the same reason the liveness sample is: afterwards the
  // pid may be free, and a free pid cannot tell anyone which process used to hold it. A
  // failure to sample is recorded as absence — a reader without an identity declines to
  // attribute rather than attributing to a pid it cannot vouch for.
  let identity: ProcessIdentity | undefined
  try {
    identity = typeof pid === 'number' && pid > 0 ? readIdentity(pid) : undefined
  } catch {
    identity = undefined
  }
  let durablyRecorded: GatewayShutdownObservation | null = null
  if (options.replRegistryPath !== undefined) {
    // AN ENTRY IS WRITTEN FOR EVERY OUTCOME, not only for a kill — and that is the
    // correction to an earlier revision, which wrote nothing unless we had killed the
    // child. Its reasoning was that a record would EXCUSE a death we did not cause,
    // and that reasoning was right about a record that can only say "we killed this".
    // It is wrong about one that says WHAT WAS OBSERVED: an `already-gone` entry
    // excuses nothing, it records that the shutdown reached a child that had already
    // died. Writing nothing left `undetermined` sharing its representation with an
    // ordinary crash, so a retry reported the honest uncertainty as a confident crash.
    const wrote = recordGatewayShutdownOutcome(
      options.replRegistryPath,
      sessionKey,
      childGeneration,
      at,
      observed,
      pid,
      // THE SAME SEAM THE POOL USES before evicting a child that hosts live work — the
      // identical question ("does a live run still reference this generation?"), asked one
      // layer down about a RECORD rather than a process. Absent, retention falls back to
      // age alone, which is the conservative reading rather than a silent "nothing is
      // referenced".
      options.hostsLiveWork === undefined
        ? undefined
        : (generation) => {
            try {
              return options.hostsLiveWork!(generation) > 0
            } catch {
              return false
            }
          },
      identity,
    )
    durablyRecorded = wrote ? observed : null
    if (!wrote) {
      // The row is gone, or unwritable. A best-effort write that quietly did nothing is
      // the silence this module exists to remove, so it is said out loud — AND carried
      // on the report, so the delivery phase cannot promise a recovery that has nothing
      // to recover from.
      process.stderr.write(
        `[repl] gateway shutdown could not record the durable marker for generation=${childGeneration.slice(0, 8)} ` +
          `(no registry row for this session, or it could not be written) — this death is reported by the live ` +
          `sink ONLY, and is lost if that does not land\n`,
      )
    }
  }
  // RETURNED EVEN WITH NO SINK WIRED. It used to return `null` here, which conflated
  // "nothing to DELIVER" with "nothing to CONFIRM" — so a substrate without a sink never
  // had its record promoted to `alive-and-killed`, and a death the shutdown genuinely
  // caused was reported on the next boot as cause-not-established. The delivery phase
  // already skips a report whose sink is absent; confirmation must still happen.
  return {
    options,
    sessionKey,
    childGeneration,
    at,
    observed,
    liveness,
    durablyRecorded,
    ...(typeof pid === 'number' && pid > 0 ? { pid } : {}),
  }
}

/**
 * PHASE 3 — attempt the owed live reports, AFTER every child is marked and killed.
 *
 * BOUNDED TWICE, and both bounds are load-bearing. Each sink call gets at most
 * {@link SHUTDOWN_REPORT_PER_SINK_MS}, so one hung sink cannot hold the phase; the
 * phase gets at most {@link SHUTDOWN_REPORT_PHASE_BUDGET_MS} in total, so N hung
 * sinks cannot each spend the per-sink bound out of a deadline the rest of the
 * teardown also needs. A report that runs out of budget is ABANDONED, not awaited:
 * the promise is left with a catch attached so a later rejection cannot surface as
 * an unhandled one, and the child it describes is already dead and already marked.
 *
 * LOSING A REPORT HERE IS SURVIVABLE BY CONSTRUCTION, which is the whole point of
 * doing the marker first: the next boot's watchdog reads the marker and delivers the
 * ATTRIBUTED report. Losing a marker or a kill is not survivable, which is why
 * neither is allowed behind this.
 *
 * Returns a per-outcome tally rather than `void` — a phase that delivered nothing
 * must be distinguishable from one that delivered everything.
 */
/**
 * What an undelivered report actually costs, per report.
 *
 * The delivery phase is best-effort BECAUSE a durable record sits behind it — but
 * that is a property of the individual report, not of the phase. A report with no
 * record behind it is the only one this module can genuinely lose, and it says so
 * instead of repeating the reassurance that applies to its neighbours.
 */
function recoveryConsequence(report: PendingShutdownKillReport): string {
  if (report.durablyRecorded === null) return 'and NOTHING durable records this death — it is lost'
  if (report.durablyRecorded === report.observed) return 'the next boot reports it from the durable record'
  // A record exists but says LESS than this report does — the post-kill promotion did not
  // land. The death is still reported next boot, with a weaker cause. Saying "recovered"
  // here would promise the attribution and deliver the undetermined one.
  return (
    `the next boot reports it as "${report.durablyRecorded}" — WEAKER than this report, ` +
    `because the durable record could not be promoted`
  )
}

/**
 * IS THE CHILD ESTABLISHED DEAD? — which is NOT the same question as "what killed it",
 * and answering only the second is how an honest value reached a destination that lies.
 *
 * `onChildCrash` is a DEATH sink: its production implementation latches
 * `crashRunningByLauncher`, which marks every still-running trident run on that launcher
 * `crashed`. Calling it with `cause: 'unknown'` makes the CAUSE honest and the CHANNEL
 * false — the report says "nobody established why" and the destination asserts "it died"
 * anyway. For the one child this item exists to protect, the one that SURVIVED the
 * deploy because our kill never landed, that marks a live build crashed. The same error
 * as the `attributed` boolean, one layer out: there the value was derivable before the
 * act, here the destination asserts death regardless of what the value says.
 *
 * Only two observations establish a death:
 *   - `alive-and-killed` — the exit was observed, after a signal we delivered.
 *   - `already-gone`     — the child was gone before the shutdown reached it.
 * `alive-when-reached` and `could-not-sample` do NOT: the child may still be running.
 * Those are reported on a NOTIFY-ONLY path and leave the crash edge open, so if the
 * child does die, the next boot's watchdog — which confirms the death against the
 * process table first — is the one that reports it.
 */
function deathIsEstablished(observed: GatewayShutdownObservation): boolean {
  return observed === 'alive-and-killed' || observed === 'already-gone'
}

/** Tell the operator about a disposition nothing may act on, WITHOUT touching a run row.
 *  `postWedgeAlert` is the tree's existing notify-only seam (stderr by default). */
function notifyUndeterminedDisposition(report: PendingShutdownKillReport): void {
  const text =
    `gateway shutdown could not establish what happened to generation=${report.childGeneration.slice(0, 8)} ` +
    `(${report.observed}) — NOT reported as a death: the child may still be running, and ` +
    `${recoveryConsequence(report)} once its death is confirmed against the process table`
  const post = report.options.postWedgeAlert
  if (post !== undefined) {
    try {
      post(text)
      return
    } catch {
      /* fall through to stderr — a notify seam that throws must not lose the notice */
    }
  }
  process.stderr.write(`[repl] ${text}\n`)
}

export async function deliverShutdownKillReports(
  reports: readonly PendingShutdownKillReport[],
  opts: {
    perSinkMs?: number
    phaseBudgetMs?: number
    now?: () => number
    /** The bounded wait, injectable AND CANCELLABLE. A test passes one that RECORDS the
     *  budget it was asked for, resolves only if asked to, and reports whether it was
     *  CANCELLED — so the bound is asserted from what the code computed rather than from
     *  elapsed wall-clock (a real timer racing a never-settling sink is at the mercy of a
     *  loaded event loop, and these cases failed only in a 206-file process) WITHOUT the
     *  fake quietly removing the cancellation the real one needs. See {@link BoundedWait}. */
    wait?: WaitFactory
  } = {},
): Promise<{ delivered: number; timedOut: number; failed: number; skipped: number; withheld: number }> {
  const perSinkMs = opts.perSinkMs ?? SHUTDOWN_REPORT_PER_SINK_MS
  const phaseBudgetMs = opts.phaseBudgetMs ?? SHUTDOWN_REPORT_PHASE_BUDGET_MS
  const now = opts.now ?? Date.now
  const wait = opts.wait ?? cancellableWait
  const phaseDeadline = now() + phaseBudgetMs
  const tally = { delivered: 0, timedOut: 0, failed: 0, skipped: 0, withheld: 0 }

  // UNBACKED REPORTS GO FIRST. Delivery is best-effort BECAUSE a durable record sits
  // behind it — but that is a property of the individual report, and for one whose record
  // is missing or weaker than the report, this live attempt is the ONLY channel. Ordering
  // costs nothing (no extra waiting, the same bounds) and it spends a scarce budget on the
  // reports that cannot be recovered without it. It narrows the residual rather than
  // removing it: a death whose registry write failed AND whose sink fails is still lost,
  // which is why the spec item no longer claims otherwise.
  const ordered = [...reports].sort((a, b) => {
    const unbacked = (r: PendingShutdownKillReport): number => (r.durablyRecorded === r.observed ? 1 : 0)
    return unbacked(a) - unbacked(b)
  })

  for (const report of ordered) {
    const remaining = phaseDeadline - now()
    if (remaining <= 0) {
      // The phase is spent. Everything left is already marked and killed, so the
      // next boot reports it; saying so beats discovering it there.
      tally.skipped += 1
      process.stderr.write(
        `[repl] gateway shutdown reporting budget spent — generation=${report.childGeneration.slice(0, 8)} ` +
          `was not reported live; ${recoveryConsequence(report)}\n`,
      )
      continue
    }
    if (!deathIsEstablished(report.observed)) {
      // WITHHELD FROM THE DEATH SINK, and it costs no budget: there is nothing to tell a
      // consumer that can only record a death. The durable entry stays, and the crash
      // edge stays OPEN, so a death that does happen is still reported — by the reader
      // that confirms it first.
      tally.withheld += 1
      notifyUndeterminedDisposition(report)
      continue
    }
    const sink = report.options.onChildCrash
    if (sink === undefined) {
      tally.skipped += 1
      continue
    }
    const budget = Math.min(perSinkMs, remaining)
    const TIMED_OUT = Symbol('timed-out')
    let settled: unknown
    // DECLARED OUT HERE because the timed-out branch still needs it: a bound we stopped
    // waiting on does not stop the work behind it.
    let call: Promise<void> = Promise.resolve()
    try {
      call = Promise.resolve(
        sink({
          sessionKey: report.sessionKey,
          generationKey: report.childGeneration,
          // DERIVED FROM WHAT WAS ESTABLISHED, not from a boolean sampled before the
          // act. `'alive-and-killed'` is reachable only through `confirmShutdownKill`.
          cause: report.observed === 'alive-and-killed' ? 'gateway-shutdown' : 'unknown',
          detail:
            report.observed === 'alive-and-killed'
              ? gatewayShutdownKillDetail(report.at)
              : undeterminedShutdownDetail(report.observed, report.at),
        }),
      ).then(() => undefined)
      // A sink we abandon must not become an unhandled rejection later. Attaching the
      // catch here — to the ORIGINAL promise, not to the race — is what makes
      // abandoning it safe.
      call.catch(() => undefined)
      // CANCELLED THE MOMENT THE SINK WINS. Left running, this timer holds the whole
      // runtime open for the rest of the budget — so an instant report cost the
      // shutdown its full per-sink bound anyway, out of a deadline systemd is counting.
      const bound = wait(budget)
      try {
        settled = await Promise.race([call, bound.expired.then(() => TIMED_OUT)])
      } finally {
        bound.cancel()
      }
    } catch (err) {
      tally.failed += 1
      process.stderr.write(
        `[repl] onChildCrash sink threw on gateway-shutdown kill generation=${report.childGeneration.slice(0, 8)}: ${String(err)} ` +
          `— ${recoveryConsequence(report)}\n`,
      )
      continue
    }
    if (settled === TIMED_OUT) {
      tally.timedOut += 1
      process.stderr.write(
        `[repl] onChildCrash sink did not answer within ${budget}ms for generation=${report.childGeneration.slice(0, 8)} ` +
          `— abandoned; ${recoveryConsequence(report)}\n`,
      )
      // ABANDONED IS NOT CANCELLED. The sink call is still in flight and may COMMIT a
      // moment after we stopped waiting — and the production sink's commit is a durable
      // write to the run row. Leaving the edge open then means the next boot reports the
      // SAME death again, over the top of a reason that already landed, straight into
      // the last-writer-wins hazard this module documents. So a late success closes the
      // edge exactly as an on-time one does; a late failure leaves it open, which is
      // what the backstop is for.
      fireAndForget(
        'gateway-shutdown-kill.late-sink-commit',
        // ONE ARM ONLY. A late FAILURE is not a late commit — the edge stays open,
        // which is what the next boot's backstop is for — and swallowing it here with a
        // second `.then` arm would hide it from the wrapper that exists to log it.
        call.then(() => {
          process.stderr.write(
            `[repl] the abandoned onChildCrash sink for generation=${report.childGeneration.slice(0, 8)} ` +
              `COMMITTED after its ${budget}ms bound — closing the crash edge so the next boot does not ` +
              `report this death a second time over the reason that landed\n`,
          )
          if (report.options.replRegistryPath !== undefined) {
            closeCrashReportEdge(report.options.replRegistryPath, report.sessionKey, report.childGeneration, report.at)
          }
        }),
      )
      continue
    }
    tally.delivered += 1
    // COMMITTED — and only now is the edge closed, so the next boot does not report
    // this death a second time. A timed-out or thrown report deliberately leaves it
    // OPEN so the backstop still fires.
    //
    // KEYED ON `delivered`, NOT ON `attributed`, AND THE DIFFERENCE IS A DEFECT THIS
    // ALREADY HAD. The edge means "this death's report is closed". A delivered
    // `cause: 'unknown'` closes it — the report happened and it said what was true.
    // Keying it on attribution instead conflated "we told the owner something" with
    // "we told the owner it was a deploy", and left the edge open after an honest
    // undetermined report: the next watchdog tick then passed the reporting gate and
    // reported the SAME death as `cause: 'child-died'`, which
    // `crashRunningByLauncher` writes over the tombstone unconditionally. An honest
    // "I could not tell" was replaced by a confident "the child died" — the very
    // misattribution this module exists to prevent, by a new route.
    //
    // `unknown` was not a possible value when this condition was written, which is
    // why nothing about it was wrong until it was. THE RULE: every new state has to be
    // checked against every field whose meaning was defined before that state existed.
    if (report.options.replRegistryPath !== undefined) {
      closeCrashReportEdge(report.options.replRegistryPath, report.sessionKey, report.childGeneration, report.at)
    }
  }
  return tally
}

/**
 * Record and deliver in one call — the single-child convenience used by callers that
 * are NOT inside the shutdown walk (and by tests). Callers that ARE must use
 * {@link recordGatewayShutdownKill} and {@link deliverShutdownKillReports} so that no
 * child's marker or kill sits behind another child's sink.
 */
export async function reportGatewayShutdownKill(
  options: PersistentReplSubstrateOptions,
  sessionKey: string,
  childGeneration: string,
  at: number,
  liveness: ShutdownLivenessSample,
  /** WHAT THE KILL DID. Required, and deliberately not defaulted: this wrapper does not
   *  perform the kill, so it cannot know — and a convenience that quietly assumed
   *  success would be the same over-claim the split exists to remove, reintroduced at
   *  the one seam that looks harmless. */
  outcome: { killed: boolean },
  pid?: number,
): Promise<void> {
  const owed = recordGatewayShutdownKill(options, sessionKey, childGeneration, at, liveness, pid)
  confirmShutdownKill(owed, outcome)
  if (owed !== null) await deliverShutdownKillReports([owed])
}
