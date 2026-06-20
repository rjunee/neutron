/**
 * in-flight-gate.ts — process-local mutex that prevents overlapping invocations
 * of an async tick (or two concurrent respawns for the same key) from racing.
 *
 * LIFTED VERBATIM from Nova `gateway/in-flight-gate.ts` (substrate-lift S2 § 2
 * row #14, ★ CORE-PRESERVED-VERBATIM). Pure boolean — no host coupling.
 *
 * Pattern: a watchdog tick fires every N seconds via setInterval. The work it
 * dispatches (probing child liveness, scanning the registry, actuating a
 * respawn) can take longer than N. Without a gate, ticks 2 and 3 slip past the
 * cadence check tick 1 hadn't yet committed and double-fire the respawn.
 *
 * Process-local (not flock-based) because the callers live inside ONE gateway
 * process, single-instance per host. The CROSS-process double-spawn guard is
 * `registry-lock.ts` (flock on the persisted registry). The two compose: the
 * gate serializes same-process ticks; the flock serializes restart/multi-tick.
 *
 * Always release in a `finally` so a thrown handler doesn't latch the gate shut
 * for the lifetime of the process.
 */

export interface InFlightGate {
  /** Returns true if the caller claimed the gate, false if already held. */
  claim(): boolean
  /** Release the gate. Idempotent — safe to call without a prior claim. */
  release(): void
}

export function makeInFlightGate(): InFlightGate {
  let held = false
  return {
    claim: () => {
      if (held) return false
      held = true
      return true
    },
    release: () => {
      held = false
    },
  }
}
