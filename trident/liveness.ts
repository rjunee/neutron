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
 * warning on its Plan item. DISPLAY only — deliberately shorter than the
 * `NO_ADVANCE_HANG_MS` reap threshold so a stall is warned about before it is
 * reaped.
 *
 * RAISED from 10 min on 2026-08-11, for the same reason the reap threshold moved:
 * `last_advanced_at` is stale by construction during a long phase, so at 10 min
 * this warned "⚠️ stalled" on every healthy build with a Forge step longer than
 * ten minutes. A warning that fires on healthy work teaches the owner to ignore
 * the warning — and he had already told us the board could not be trusted. It
 * stays well under the reap threshold so the ordering the paragraph above
 * promises still holds.
 * Default: 30 minutes.
 */
export const STALLED_WARN_MS = 30 * 60_000

/**
 * Per-agent hang watchdog default (M1 trident-UX hardening, item 2). A
 * non-terminal run whose `last_advanced_at` has not moved for this long while a
 * dispatch is in flight is reaped as a suspected agent hang.
 *
 * ⚠️ THIS THRESHOLD KILLED A HEALTHY BUILD ON 2026-08-11 AND IS NOW A STOPGAP.
 * The owner's Email Core P1 build was reaped at 26 minutes — one minute past the
 * old 25 — while Forge was demonstrably still working: its transcript was 381 KB
 * and 8 seconds old, and the uncommitted files in its worktree were the right
 * shape for the task. The estimate below ("a large build can legitimately run
 * 15–20 min") was simply too small for a real build against a governed spec.
 *
 * THE REAL DEFECT IS THE SIGNAL, NOT THE NUMBER, and raising it does not fix
 * that. `last_advanced_at` only moves at CHECKPOINT boundaries, and checkpoints
 * land between phases rather than during one — so during a long Forge step this
 * field is stale by construction, no matter how hard the agent is working. A
 * reaper keyed on it is asking "has a phase ended recently", not "is anything
 * alive". ISSUES #534 tracks the fix: emit a real mid-phase progress heartbeat
 * and have BOTH this reaper and the Work Board read that instead. The activity
 * stream that would feed it already exists and already reaches the client.
 *
 * This is the third instance of one root pattern on a single day — a 90s
 * PTY-silence watchdog killed the planner (Open #185), a stale
 * `last_advanced_at` makes the board look dead (#534), and the same stale field
 * makes this reaper kill the build. In every case the liveness signal does not
 * measure liveness.
 *
 * 90 min is chosen to be OBVIOUSLY generous rather than finely tuned, because a
 * tuned number is what failed: the previous value was fitted to an estimate of
 * how long a build "should" take, and reality exceeded it by one minute. The
 * `DEFAULT_MAX_INFLIGHT_MS` ceiling (2h) still bounds a genuinely wedged run, so
 * the cost of being generous here is a wedge sitting for longer before reaping —
 * recoverable, and strictly better than killing work in progress. Tune via
 * `no_advance_hang_ms`.
 * Default: 90 minutes (STOPGAP — see #534).
 */
export const NO_ADVANCE_HANG_MS = 90 * 60_000

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
