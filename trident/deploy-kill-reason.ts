/**
 * deploy-kill-reason.ts — the ONE place that authors "a deploy killed this
 * build", and the only place that recognises it again (#518).
 *
 * A trident inner workflow runs detached inside a warm `claude` REPL the gateway
 * owns, so restarting the service — which is what a deploy does once it has
 * checked out the new vendor tree — kills every build in flight. That part is
 * being fixed by moving the REPL out of the gateway's process tree (#538/#539).
 * THIS module fixes the half that is needed either way: the owner must be told
 * which of the two happened, and never handed a bare "child crashed" for an event
 * that was a deploy.
 *
 * Two writers reach here, one per detection half:
 *   - PUSH — `open/wiring/substrates.ts`'s `onChildCrash` sink, fired by the
 *     shutdown path itself (`reportGatewayShutdownKill`) and by the next boot's
 *     supervision watchdog reading the durable marker.
 *   - PULL — `trident/tick.ts`'s launcher-liveness loop, when the external probe
 *     answers `'killed-by-gateway-shutdown'` for a run's recorded generation.
 *
 * One reader: `interpretFailure` (`delivery.ts`), which turns the stored reason
 * into the owner-facing announce. It matches {@link DEPLOY_RESTART_KILL_MARKER},
 * which is why the marker is a constant here and not a phrase repeated in three
 * files — `delivery.ts` already carries the scar of reasons reworded out from
 * under their classifier.
 *
 * WORD CHOICE IS THE FEATURE. The reason must contain the word "deploy", because
 * that is the acceptance criterion and because "restart" alone leaves the owner
 * asking which restart. It must NOT contain `crash`/`crashed`, `stalled`,
 * `exhausted`, `conflict` or a bare `git ` — `delivery.ts` routes on those tokens
 * and would answer a deploy with review-flavoured or hang-flavoured copy.
 */

/** The authored token every deploy/restart kill reason carries, and the only
 *  thing `interpretFailure` matches on. Never reword one half alone. */
export const DEPLOY_RESTART_KILL_MARKER = 'killed by a gateway restart or deploy'

/** Which detector saw it. Recorded in the reason because the two have different
 *  evidence and a reader should not have to guess which one spoke. */
export type DeployKillWitness =
  /** The dying gateway itself, or the next boot's supervision watchdog reading
   *  the durable marker it left on the REPL registry row. */
  | 'child-crash-sink'
  /** Trident's external launcher-liveness probe, asking about a generation. */
  | 'launcher-liveness-probe'

export interface DeployKillReasonParts {
  witness: DeployKillWitness
  /** The launcher child generation that hosted this run. */
  generationKey: string
  /** The observation site's evidence sentence. */
  detail: string
  /** When this was observed (not when the kill happened — the marker's own
   *  timestamp travels inside `detail`). */
  observedAt: Date
}

/**
 * Compose the durable `failure_reason` for a run whose launcher a gateway
 * shutdown deliberately terminated.
 *
 * Deliberately short. `interpretFailure`'s fallback arm prints an unclassified
 * reason verbatim only while it stays under 200 characters, and this reason is
 * classified — but the two halves must not be one reword away from a build's
 * owner being told "The build did not complete."
 */
export function deployRestartKillReason(parts: DeployKillReasonParts): string {
  return (
    `inner workflow ${DEPLOY_RESTART_KILL_MARKER} of this instance, not by a fault: ` +
    `${parts.detail} (launcher generation ${parts.generationKey.slice(0, 8)}; ` +
    `observed by the ${parts.witness} at ${parts.observedAt.toISOString()})`
  )
}

/** Was this stored reason authored by {@link deployRestartKillReason}? The
 *  classifier's single question — a lowercase-insensitive substring check, the
 *  same shape `delivery.ts` uses for its other authored markers. */
export function isDeployRestartKillReason(reason: string): boolean {
  return reason.toLowerCase().includes(DEPLOY_RESTART_KILL_MARKER)
}
