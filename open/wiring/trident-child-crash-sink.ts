/**
 * trident-child-crash-sink.ts — the PUSH half of launcher-death reporting: what
 * gets written to a trident run when the warm REPL hosting its detached inner
 * workflow is gone.
 *
 * Lifted out of the `cc-trident-fire-*` substrate literal in `substrates.ts`
 * (#518) for one reason: it is the code the spec item's acceptance is ABOUT ("a
 * deploy-caused death is never reported as a bare 'child crashed' — assert the
 * stored reason names the deploy"), and while it was an inline closure the only
 * way to test it was to retype its composition in the test, which asserts that a
 * copy of the code does what the copy does. The wiring now passes this function
 * and the test calls this function.
 *
 * TWO ARMS, AND BOTH ARE LOAD-BEARING:
 *
 *   - `cause: 'gateway-shutdown'` — the gateway that owned the REPL killed it on
 *     its own way down (`shutdownAllPersistentRepls`, from the SIGTERM handler: a
 *     service restart, which is what a deploy ends with), or the next boot's
 *     watchdog read the durable marker it left on the registry row. The stored
 *     reason NAMES THE DEPLOY.
 *   - `cause: 'child-died'` — the pid went away and we did not ask it to, or the
 *     pool evicted an abandon-poisoned child. The stored reason stays the #240
 *     crash sentence: what was observed (crash time, gateway boot time) with no
 *     claim about cause.
 *
 * A change that reported EVERYTHING as a deploy would satisfy the first bullet
 * and be worthless. The second is what makes the first mean anything, and it is
 * the criterion the spec item states negatively: the 08-10 23:30 and 08-11 06:04
 * crashes have no checkout near them and must not be attributed to a deploy.
 */

import { deployRestartKillReason } from '@neutronai/trident/deploy-kill-reason.ts'
import type { ChildCrashInfo } from '@neutronai/runtime/adapters/claude-code/index.ts'

/** The one store call this sink makes — `TridentRunStore.crashRunningByLauncher`. */
export interface TridentLauncherCrashLatch {
  (session_key: string, failure_reason: string): Promise<void>
}

export interface TridentChildCrashSinkDeps {
  latch: TridentLauncherCrashLatch
  /** Observation clock. Defaults to the wall clock. */
  now?: () => Date
  /** When this gateway process booted — #240 evidence, reported WITHOUT claiming
   *  it caused the crash. Defaults to `process.uptime()`. */
  gateway_booted_at?: () => Date
}

/**
 * Build the `onChildCrash` sink for the warm `cc-trident-fire-*` launcher.
 *
 * #514 — the supervision watchdog knows synchronously when this warm launcher's
 * child died; stamping every still-live workflow the dead generation owned lets
 * the tick perform the normal terminal transition + board reconcile instead of
 * leaving a durable `running` phantom until the timeout. #518 adds WHICH death it
 * was. Neither subsumes the other: #514 is what the row does after a child dies,
 * this is whether the row says why.
 */
export function buildTridentChildCrashSink(
  deps: TridentChildCrashSinkDeps,
): (info: ChildCrashInfo) => Promise<void> {
  const now = deps.now ?? ((): Date => new Date())
  const bootedAt = deps.gateway_booted_at ?? ((): Date => new Date(Date.now() - process.uptime() * 1000))
  return async ({ generationKey, cause, detail }: ChildCrashInfo): Promise<void> => {
    const observed = now()
    // A DEPLOY IS NOT A CRASH, AND HERE WE KNOW WHICH IT WAS — the only place in
    // this family where cause is MEASURED (the dying gateway wrote it down) rather
    // than correlated, so it is stated outright. The owner reading "pooled child
    // exited" for a build a deploy killed went looking for a bug that was never
    // there, and the 08-13 instance was trident's own merge deploying over the
    // builds still running.
    if (cause === 'gateway-shutdown') {
      await deps.latch(
        generationKey,
        deployRestartKillReason({
          witness: 'child-crash-sink',
          generationKey,
          detail,
          observedAt: observed,
        }),
      )
      return
    }
    // #240 — measure the cause rather than asserting one. Report what was actually
    // observed so a reader can correlate crashes with deploys/restarts, without
    // claiming the restart caused this specific crash. THE COMPLEMENT, and it must
    // stay a crash sentence: a child that died with no shutdown marker on its row
    // has no deploy to blame, and crediting one is the same defect in reverse.
    await deps.latch(
      generationKey,
      `inner workflow child crashed: ${detail} (observed ${observed.toISOString()}; gateway process booted ${bootedAt().toISOString()})`,
    )
  }
}
