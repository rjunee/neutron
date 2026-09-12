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
 * demands equality with the row's CURRENT generation. `spawn.ts` also drops both
 * fields when it writes a new generation, the same way it drops the crash edge —
 * belt and braces, because this is the mutation that would make the reporting
 * lie in the one direction the spec item forbids (a fault credited to a deploy).
 *
 * ── AND THE ROW IS SCOPED TOO, WHICH IS A SEPARATE CLAIM ─────────────────────
 * The marker is per-generation; the ROW it lives in is per SESSION KEY, and one
 * teardown can reach two generations on one key — the pooled child, and a
 * QUARANTINED child that used to hold that key before a fresh spawn took it over.
 * Writing both would leave the row naming one generation and the marker naming the
 * other: attribution then fails AND `child_crash_notified_at` stays set, killing
 * the durable backstop in precisely the case it exists for (the direct sink
 * throwing).
 *
 * {@link markKilledByGatewayShutdown} therefore REFUSES to mark a generation the
 * row does not currently name. Nothing is lost by refusing: both next-boot
 * consumers look the row up and match on its CURRENT `child_generation`
 * (`wasKilledByGatewayShutdown`, `probeLauncherGenerationAlive`), so a marker for a
 * superseded generation could never have been read back — writing it could only
 * ever have destroyed a usable one. The refusal is reported, not silent.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 * It is not a drain, and it does not keep the workflow alive. Surviving the
 * restart is the herdr-host half of the acceptance (#538 moves the REPL out of
 * the gateway's process tree and cgroup; #539 gates this very kill and adds the
 * adopt arm `orphan-adoption.ts` has never had). Until then the build dies — and
 * this module is why the owner is TOLD that a deploy killed it.
 */

import { getRecord, patchRecord, type ReplRegistryRecord } from './repl-registry.ts'
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
  if (record === undefined) return false
  const marked = record.killed_by_gateway_shutdown_generation
  if (typeof marked !== 'string' || marked.length === 0) return false
  return marked === record.child_generation
}

/** Epoch ms the marker was written, or undefined when the row carries no live
 *  marker. Returns undefined for a stale (superseded-generation) marker, so a
 *  caller can never quote a timestamp that does not describe this child. */
export function gatewayShutdownKillAt(record: ReplRegistryRecord | undefined): number | undefined {
  if (!wasKilledByGatewayShutdown(record)) return undefined
  const at = record?.killed_by_gateway_shutdown_at
  return typeof at === 'number' && Number.isFinite(at) ? at : undefined
}

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
export function undeterminedShutdownDetail(liveness: ShutdownLivenessSample, at: number): string {
  const when = new Date(at).toISOString()
  return liveness === 'could-not-sample'
    ? `its launcher's liveness could not be read when the gateway shut down at ${when}, ` +
        `so whether the shutdown ended it is UNDETERMINED — not established as a deploy, not established as a fault`
    : `its launcher was ALREADY gone when the gateway shut down at ${when}, so the shutdown did not end it; ` +
        `what did is UNDETERMINED — not established as a deploy, not established as a fault`
}

/**
 * Record the deliberate kill on the durable registry row, BEFORE the child is
 * killed — after it, the process may not get another scheduler turn.
 *
 * Also stamps `child_crash_notified_at`: the caller notifies the durable crash
 * sink itself (it is the only place that still has one), and the next boot's
 * watchdog would otherwise re-notify the SAME pid edge with its own bare detail.
 * That second write is not harmless — `crashRunningByLauncher` upserts
 * `ON CONFLICT(session_key) DO UPDATE SET failure_reason = excluded.failure_reason`
 * (`trident/store.ts`), so a late bare "pooled child exited" would overwrite the
 * deploy attribution in the tombstone that `saveIfActive` reads back.
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
export function markKilledByGatewayShutdown(
  registryPath: string,
  sessionKey: string,
  childGeneration: string,
  at: number,
): boolean {
  try {
    // THE ROW MUST ALREADY NAME THIS GENERATION. One teardown can reach two
    // generations on one session key (the pooled child, and a quarantined child that
    // held the key before a fresh spawn took it over) and they share this row. A
    // write for a generation the row has moved past would leave the row naming one
    // and the marker naming the other — attribution then fails AND
    // `child_crash_notified_at` stays set, which disables the next boot's backstop in
    // the one case it exists for. Refusing costs nothing: both consumers match on the
    // row's CURRENT `child_generation`, so such a marker was never readable anyway.
    if (getRecord(registryPath, sessionKey)?.child_generation !== childGeneration) return false
    patchRecord(registryPath, sessionKey, {
      killed_by_gateway_shutdown_generation: childGeneration,
      killed_by_gateway_shutdown_at: at,
      child_crash_notified_at: at,
    })
    return wasKilledByGatewayShutdown(getRecord(registryPath, sessionKey))
  } catch {
    return false
  }
}

/**
 * Tell the durable crash sink that a gateway shutdown killed this child, and
 * record the same fact on the registry row for the next boot.
 *
 * The sink call is AWAITED: the gateway closes its database a few statements
 * after `shutdownAllPersistentRepls` returns (`gateway/index.ts`), so a
 * fire-and-forget write here would race `db.close()` and lose exactly the report
 * this exists to produce. A throwing sink is logged to stderr and does not stop
 * the shutdown — the registry marker is the backstop that gets the next boot to
 * the same answer.
 */
export async function reportGatewayShutdownKill(
  options: PersistentReplSubstrateOptions,
  sessionKey: string,
  childGeneration: string,
  at: number,
  liveness: ShutdownLivenessSample,
): Promise<void> {
  // ATTRIBUTION FOLLOWS THE OBSERVATION, not the call site. Only a child observed
  // ALIVE was killed by this shutdown; anything else is reported as undetermined.
  const attributed = liveness === 'alive'
  if (attributed && options.replRegistryPath !== undefined) {
    // The marker is an EXCUSE for a death, so it is written only where the death is
    // ours to own. Writing it for a child that was already gone would excuse a fault,
    // and it also closes the crash edge — which would silence the next boot's honest
    // report of the very fault we are refusing to claim.
    const marked = markKilledByGatewayShutdown(options.replRegistryPath, sessionKey, childGeneration, at)
    if (!marked) {
      // Refused (the row has moved on to another generation) or unwritable. The live
      // sink call below still goes out; the DURABLE backstop does not, and a
      // best-effort write that quietly did nothing is the silence this module exists
      // to remove.
      process.stderr.write(
        `[repl] gateway shutdown could not record the durable marker for generation=${childGeneration.slice(0, 8)} ` +
          `(the registry row names a different generation, or could not be written) — the live report was still sent\n`,
      )
    }
  }
  if (options.onChildCrash === undefined) return
  try {
    await options.onChildCrash({
      sessionKey,
      generationKey: childGeneration,
      cause: attributed ? 'gateway-shutdown' : 'unknown',
      detail: attributed ? gatewayShutdownKillDetail(at) : undeterminedShutdownDetail(liveness, at),
    })
  } catch (err) {
    process.stderr.write(
      `[repl] onChildCrash sink threw on gateway-shutdown kill generation=${childGeneration.slice(0, 8)}: ${String(err)}\n`,
    )
  }
}
