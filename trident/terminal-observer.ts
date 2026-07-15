/**
 * @neutronai/trident — compose an extra observer onto the terminal hook.
 *
 * The tick loop fires ONE `on_terminal` hook per terminal run. Production needs
 * two things to happen on a terminal transition: (1) delivery — post the result
 * back to the originating chat (`buildTridentDelivery`), and (2) an optional
 * observer — e.g. Skill Forge's auto-skillify audit (`trident.on_run_terminal`).
 *
 * These MUST be isolated: delivery talks to the network (`ChannelRouter.send`),
 * so a delivery outage must NOT swallow the observer. The run has already
 * transitioned to its terminal phase, so the tick loop will never re-fire the
 * hook — if delivery threw before the observer ran, a completed `done` run would
 * permanently miss its Skill Forge proposal. So:
 *   - delivery runs first (preserve the user-visible result ordering),
 *   - its failure is captured (not allowed to skip the observer),
 *   - the observer runs regardless; ITS failure is logged, never propagated
 *     (an observer hiccup must not look like a delivery failure),
 *   - the captured delivery error is then re-thrown, so the loop's existing
 *     `on_terminal` try/catch logs delivery failures EXACTLY as before.
 */

import type { TridentRun } from './store.ts'
import type { TridentTerminalHook } from './tick.ts'
import { createLogger } from '@neutronai/logger'

const log = createLogger('trident')

export function withTerminalObserver(
  delivery: TridentTerminalHook,
  observer: (run: TridentRun) => Promise<void>,
): TridentTerminalHook {
  return {
    async onTerminal(run: TridentRun): Promise<void> {
      let deliveryError: unknown = null
      try {
        await delivery.onTerminal(run)
      } catch (err) {
        deliveryError = err
      }
      try {
        await observer(run)
      } catch (err) {
        log.warn('terminal_observer_failed', {
          run: run.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      if (deliveryError !== null) throw deliveryError
    },
  }
}

/**
 * Compose the terminal-observer chain from `delivery` + zero-or-more independent
 * observers (board reconcile, skill-forge, …). This is the ONE assembly both the
 * tick loop (`build-core-modules`) and the out-of-band `terminate()` chokepoint
 * (`terminate.ts`, wired in the composer) build their `on_terminal` hook from, so
 * a cancelled build runs the EXACT same chain a loop-reaped one does (§F6a).
 *
 * Each observer is isolated in its own try/catch (a hiccup in one must not skip
 * the next), and delivery is isolated from ALL of them via `withTerminalObserver`
 * (a delivery outage must not skip the observers — the run is already terminal so
 * the hook never re-fires). With no observers this is just `delivery`.
 */
export function composeTerminalHook(
  delivery: TridentTerminalHook,
  observers: Array<(run: TridentRun) => Promise<void>>,
): TridentTerminalHook {
  if (observers.length === 0) return delivery
  const combined = async (run: TridentRun): Promise<void> => {
    for (const obs of observers) {
      try {
        await obs(run)
      } catch (err) {
        log.warn('terminal_observer_failed', {
          run: run.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
  return withTerminalObserver(delivery, combined)
}
