/**
 * @neutronai/trident — liveness timing constants.
 *
 * Centralizes the five orchestrator/launcher/resolver/progress timing thresholds
 * used across the trident build pipeline, ensuring consistent and auditable
 * ordering: warn < reap < ceiling.
 */

/**
 * Conflict resolver subprocess timeout. If the resolver's CC subprocess
 * doesn't complete its merge within this window, the build fails as unresolved.
 * Default: 8 minutes.
 */
export const DEFAULT_TIMEOUT_MS = 8 * 60_000

/**
 * Stalled-run display warning threshold. A run whose `last_advanced_at` has not
 * moved for longer than this while non-terminal is shown with a "⚠️ stalled Nm"
 * warning on its Plan item. This is the DISPLAY warning threshold only — it is
 * deliberately SHORTER than the orchestrator's `NO_ADVANCE_HANG_MS` reap threshold
 * (25m), so a stall is warned about first and only reaped to `failed` if it persists.
 * Default: 10 minutes.
 */
export const STALLED_WARN_MS = 10 * 60_000

/**
 * Per-agent hang watchdog default (M1 trident-UX hardening, item 2). A
 * non-terminal run whose `last_advanced_at` has not moved for this long while a
 * dispatch is in flight is reaped as a suspected agent hang.
 *
 * 25 min is a deliberate balance (Codex cross-model review [P1]): the ONLY
 * long no-checkpoint window in a HEALTHY build is a single Forge/fix `agent()`
 * step (checkpoints land between phases, not during one), and a large build can
 * legitimately run 15–20 min in that one step — a 15-min threshold would falsely
 * reap it. 25 min clears a normal large build while still catching the exact
 * 30+ min SILENT wedge that motivated this, FAR faster than the old 2h ceiling.
 * A reaped run is recoverable (re-run resumes from the last checkpoint). Tune via
 * `no_advance_hang_ms`.
 * Default: 25 minutes.
 */
export const NO_ADVANCE_HANG_MS = 25 * 60_000

/**
 * Max time a single inflight dispatch may run before the orchestrator considers it
 * terminal. This is the CEILING for any run's lifetime, above which we assume
 * infrastructure failure.
 * Default: 2 hours.
 */
export const DEFAULT_MAX_INFLIGHT_MS = 2 * 60 * 60_000

/**
 * Launching turn settle timeout. How long the LAUNCHING turn may take to settle
 * (fire + reply). Default 3 min — generous for a cold-spawn fire turn; NOT the
 * build budget. A cold REPL spawn can take ~100s, so the settle budget sits
 * comfortably above that.
 * Default: 3 minutes.
 */
export const DEFAULT_SETTLE_TIMEOUT_MS = 3 * 60_000
