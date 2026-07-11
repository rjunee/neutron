/**
 * @neutronai/watchdog — incident-edge dedup (F4 Blocker-1 fix).
 *
 * A watchdog condition (a cron overrun, an all-cooldown credential pool, a stale
 * heartbeat) is PERSISTENT: it stays true across many supervisor ticks. Without
 * edge tracking each tick minted a fresh alert id (it embedded `now`), so the
 * store's PRIMARY-KEY dedup never collided and the supervisor persisted + NOTIFIED
 * on EVERY tick — an alert storm (a 10-min cooldown → ~20 app/WS pings + 20
 * journal rows).
 *
 * This tracker makes alerting INCIDENT-EDGE: it fires ONCE on the false→true
 * transition (the rising edge) and stays silent while the condition holds. When
 * the condition clears (true→false) the key is dropped, so a LATER recurrence is
 * a NEW incident that fires again — a stale→healthy→stale sequence re-notifies.
 *
 * The rising-edge id embeds the edge timestamp, so the durable row for a NEW
 * incident never PK-collides with the resolved prior one. State is per-process
 * in-memory (like `DbLockContentionDetector`'s sample buffer): a restart re-fires
 * a still-true condition once, which is the correct "new process, new incident"
 * behaviour.
 *
 * Resolution notices (a true→false "cleared" alert) are DEFERRED — not a defect:
 * F4 is notify-only and the required fix is killing the storm (one incident = one
 * notification). {@link clearedSince} exposes the cleared keys for a future
 * resolution-notice PR without changing this tracker's firing contract.
 */

export class IncidentEdgeTracker {
  /** conditionKey → the incident id assigned at its rising edge (still-open incidents). */
  private readonly open = new Map<string, string>()

  /**
   * Given the condition keys that are TRUE this tick, return ONLY the keys that
   * just transitioned false→true (rising edges), each with a stable incident id
   * from `incidentIdFor(key)`. Keys already open stay suppressed; keys no longer
   * present are cleared so a later recurrence is a fresh incident. Pure w.r.t. the
   * caller — the only mutation is this tracker's own edge state.
   */
  rising(
    firingKeys: Iterable<string>,
    incidentIdFor: (key: string) => string,
  ): Array<{ key: string; id: string }> {
    const nowFiring = firingKeys instanceof Set ? firingKeys : new Set(firingKeys)
    // Drop resolved keys FIRST so a key that cleared and re-fired within the same
    // tick set is treated as still-open (it never left), not double-counted.
    for (const key of [...this.open.keys()]) {
      if (!nowFiring.has(key)) this.open.delete(key)
    }
    const risen: Array<{ key: string; id: string }> = []
    for (const key of nowFiring) {
      if (this.open.has(key)) continue // continuing incident — suppress
      const id = incidentIdFor(key)
      this.open.set(key, id)
      risen.push({ key, id })
    }
    return risen
  }

  /** Currently-open incident keys (for tests / diagnostics). */
  openKeys(): string[] {
    return [...this.open.keys()]
  }
}
