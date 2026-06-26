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
        console.warn(
          `[trident] terminal observer failed for run ${run.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
      if (deliveryError !== null) throw deliveryError
    },
  }
}
