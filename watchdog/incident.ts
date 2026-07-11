/**
 * @neutronai/watchdog — incident-edge dedup (F4).
 *
 * A watchdog condition (a cron overrun, an all-cooldown credential pool, a stale
 * heartbeat) is PERSISTENT: it stays true across many supervisor ticks. Without
 * edge tracking each tick minted a fresh alert id (it embedded `now`), so the
 * store's PRIMARY-KEY dedup never collided and the supervisor persisted +
 * NOTIFIED on EVERY tick — an alert storm (a 10-min cooldown → ~20 pings + 20
 * rows). This tracker makes alerting INCIDENT-EDGE: fire ONCE on the false→true
 * transition, stay silent while the condition holds, and re-fire only after it
 * resolves and recurs (stale→healthy→stale = a NEW incident, new id).
 *
 * COMMIT-ON-SUCCESS (Blocker round-3). The dedup "already alerted" state is
 * committed ONLY AFTER the alert has been durably persisted AND delivered. A
 * detector reports a rising edge via {@link candidates} (which does NOT latch);
 * the supervisor persists + notifies; ONLY on success does it call
 * {@link commitById}. So a TRANSIENT persist/notify failure leaves the incident
 * un-latched and it is re-attempted next tick — the alert is delivered exactly
 * once when the blip clears, never permanently suppressed by a DB/sink hiccup.
 *
 * The rising-edge id (assigned once at first observation, REUSED across retries)
 * embeds the edge timestamp, so a NEW incident never collides with a resolved
 * prior one. State is per-process in-memory (like `DbLockContentionDetector`'s
 * sample buffer): a restart re-fires a still-true condition once.
 *
 * Resolution notices (a true→false "cleared" alert) are DEFERRED — not a defect:
 * F4 is notify-only and the required fix is killing the storm (one incident = one
 * delivered notification).
 */

export class IncidentEdgeTracker {
  /** COMMITTED (delivered) incidents: conditionKey → incident id. Suppressed. */
  private readonly open = new Map<string, string>()
  /** OBSERVED but not-yet-delivered incidents: conditionKey → incident id. Retryable. */
  private readonly pending = new Map<string, string>()

  /**
   * Rising candidates: the firing keys NOT yet committed-open, each with a STABLE
   * incident id. The id is assigned once (via `incidentIdFor`) at first
   * observation and REUSED across retries, so a transient persist/notify failure
   * re-attempts the SAME incident rather than minting a new one. This does NOT
   * commit — the caller commits via {@link commitById} only after the alert is
   * durably persisted AND delivered. Keys no longer firing are cleared from BOTH
   * maps (recovery), so a later recurrence is a fresh incident.
   */
  candidates(
    firingKeys: Iterable<string>,
    incidentIdFor: (key: string) => string,
  ): Array<{ key: string; id: string }> {
    const nowFiring = firingKeys instanceof Set ? firingKeys : new Set(firingKeys)
    for (const key of [...this.open.keys()]) {
      if (!nowFiring.has(key)) this.open.delete(key)
    }
    for (const key of [...this.pending.keys()]) {
      if (!nowFiring.has(key)) this.pending.delete(key)
    }
    const out: Array<{ key: string; id: string }> = []
    for (const key of nowFiring) {
      if (this.open.has(key)) continue // already delivered — suppress
      let id = this.pending.get(key)
      if (id === undefined) {
        id = incidentIdFor(key)
        this.pending.set(key, id) // stable across retries until delivered
      }
      out.push({ key, id })
    }
    return out
  }

  /**
   * Commit an incident as DELIVERED (durably persisted + notified). Idempotent.
   * Called by the supervisor only after both succeed; until then the incident
   * stays pending and re-attempts each tick.
   */
  commitById(id: string): void {
    for (const [key, pendingId] of this.pending) {
      if (pendingId === id) {
        this.open.set(key, pendingId)
        this.pending.delete(key)
        return
      }
    }
  }

  /** Committed (delivered) incident keys — for tests / diagnostics. */
  openKeys(): string[] {
    return [...this.open.keys()]
  }
}
