/**
 * @neutronai/persistence — the usage-sample series, and the maths read off it.
 *
 * The monitor measures the active credential every 60 seconds and used to discard
 * every reading. This keeps them, so the product can answer the question the meter
 * cannot: not "how full is the window" but **"is this going to run out before it
 * resets, and when"**.
 *
 * PACE IS THE WHOLE POINT. `pace = fraction consumed ÷ fraction of the window
 * elapsed`. Above 1 means burning faster than the window refills, and that single
 * number is what turns "72%" into a decision. It is computed HERE rather than stored,
 * because a stored derivative goes stale the moment the formula improves — and this
 * formula will improve.
 */

import type { ProjectDb } from './db.ts'

/** Which quota pool a sample describes. Only one exists today. */
export type UsagePool = 'anthropic'

/** One persisted reading. Fractions are 0..1; every field may be absent upstream. */
export interface UsageSample {
  ts: number
  pool: UsagePool
  /** The account behind the reading, when anything can name it. Usually null. */
  account_label: string | null
  session: number | null
  weekly: number | null
  session_reset_at: number | null
  weekly_reset_at: number | null
}

/** What the dashboard needs about one window. */
export interface WindowSummary {
  /** Fraction consumed, 0..1, from the newest sample. */
  fraction: number
  /** Epoch MS the window resets, when upstream said. */
  reset_at: number | null
  /** Milliseconds until the reset, or null when it is unknown. */
  resets_in_ms: number | null
  /**
   * Consumed ÷ elapsed, over this window. `null` when it cannot be computed —
   * an unknown reset time, or a window that has only just started (dividing by a
   * near-zero elapsed fraction produces a number that says nothing).
   */
  pace: number | null
  /**
   * Epoch MS this window is projected to hit 100% at the current pace, or null when
   * there is no pace or the pace will not exhaust it before it resets.
   *
   * NULL IS THE COMMON, GOOD CASE and must not be rendered as a warning: a pace at or
   * under 1 means the window refills faster than it drains, so there is no exhaustion
   * to project.
   */
  exhausts_at: number | null
}

export interface PoolSummary {
  pool: UsagePool
  /** Newest sample's timestamp, or null when the series is empty. */
  measured_at: number | null
  /** Present only when something can name the account (see the migration). */
  account_label: string | null
  session: WindowSummary | null
  weekly: WindowSummary | null
}

/** How long a window lasts, for the elapsed-fraction half of pace. */
const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Below this fraction elapsed, pace is reported as null.
 *
 * Two minutes into a five-hour window, one turn's worth of usage divides by ~0.007 and
 * produces a pace in the hundreds. That number is arithmetically correct and completely
 * misleading — it says "you will run out in minutes" about a window that has barely
 * started. Refusing to answer is the honest response to a sample size of one.
 */
const MIN_ELAPSED_FRACTION = 0.05

/** Keep a month. Pruned by the writer's own tick — see the migration. */
export const USAGE_SAMPLE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Summarise one window from a reading plus the clock.
 *
 * PURE, so every branch is testable without a database: the interesting behaviour here
 * is which cases refuse to answer, and those are exactly the ones a rendered dashboard
 * makes hard to see.
 */
export function summariseWindow(
  fraction: number | null,
  reset_at: number | null,
  window_ms: number,
  now: number,
): WindowSummary | null {
  if (fraction === null || !Number.isFinite(fraction)) return null
  const resets_in_ms = reset_at !== null ? reset_at - now : null
  let pace: number | null = null
  if (reset_at !== null) {
    // The window STARTED one window-length before it resets, so elapsed is measured
    // back from the reset rather than from any timestamp we hold — the upstream reset
    // time is the only anchor we actually get.
    const started_at = reset_at - window_ms
    const elapsed = (now - started_at) / window_ms
    if (elapsed >= MIN_ELAPSED_FRACTION && elapsed <= 1) {
      pace = fraction / elapsed
    }
  }
  let exhausts_at: number | null = null
  if (pace !== null && pace > 1 && fraction < 1 && reset_at !== null) {
    // DERIVED, not guessed. `pace` is fraction-consumed per fraction-of-window
    // elapsed — i.e. the consumption RATE in window-fraction units. So the time left
    // to consume `1 - fraction` is `(1 - fraction) / pace` window-fractions, which is
    // that times `window_ms` in real time.
    //
    // A first draft here divided by pace twice (`… / pace * … * 1 / pace`), which is
    // arithmetically wrong and completely plausible-looking — it would have projected
    // exhaustion far too early on every fast window. The test below pins a
    // hand-checkable case for exactly that reason.
    exhausts_at = Math.round(now + ((1 - fraction) / pace) * window_ms)
    // NO "IS IT BEFORE THE RESET?" GUARD, because that case cannot happen — proven
    // rather than assumed, after a mutation pass showed the guard I first wrote could
    // never fire:
    //
    //   pace > 1  ⇒  fraction > elapsed.  Write fraction = elapsed + d, d > 0.
    //   projection (in window-fractions) = (1 − fraction)/pace = elapsed(1 − elapsed − d)/(elapsed + d)
    //   remaining                        = 1 − elapsed
    //   At d → 0 the two are equal; as d grows the projection's numerator falls and its
    //   denominator rises, so it strictly decreases while `remaining` is constant.
    //   ⇒ the projection is always strictly EARLIER than the reset.
    //
    // A dead branch dressed as safety is worse than none: it cannot be tested, so it
    // reads as protection that has never been exercised. If the pace definition ever
    // changes, this comment is the thing to re-derive.
  }
  return { fraction, reset_at, resets_in_ms, pace, exhausts_at }
}

export class UsageSamplesStore {
  private readonly db: ProjectDb
  private readonly now: () => number

  constructor(deps: { db: ProjectDb; now?: () => number }) {
    this.db = deps.db
    this.now = deps.now ?? ((): number => Date.now())
  }

  /**
   * Record one reading. Idempotent on (ts, pool).
   *
   * A sample with NOTHING measurable in it is not written: rows of all-nulls would
   * dilute the series and make "we have no data" indistinguishable from "we measured
   * nothing", which are different facts.
   */
  async record(input: {
    pool: UsagePool
    ts?: number
    account_label?: string | null
    session?: number | null
    weekly?: number | null
    session_reset_at?: number | null
    weekly_reset_at?: number | null
  }): Promise<boolean> {
    const session = numberOrNull(input.session)
    const weekly = numberOrNull(input.weekly)
    if (session === null && weekly === null) return false
    const ts = input.ts ?? this.now()
    const label =
      typeof input.account_label === 'string' && input.account_label.trim().length > 0
        ? input.account_label.trim()
        : null
    await this.db.run(
      `INSERT INTO usage_pool_samples
         (ts, pool, account_label, session, weekly, session_reset_at, weekly_reset_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ts, pool) DO UPDATE SET
         account_label = excluded.account_label,
         session = excluded.session,
         weekly = excluded.weekly,
         session_reset_at = excluded.session_reset_at,
         weekly_reset_at = excluded.weekly_reset_at`,
      [
        ts,
        input.pool,
        label,
        session,
        weekly,
        numberOrNull(input.session_reset_at),
        numberOrNull(input.weekly_reset_at),
      ],
    )
    return true
  }

  /** Delete samples older than the retention window. Returns how many went. */
  async prune(): Promise<number> {
    const cutoff = this.now() - USAGE_SAMPLE_RETENTION_MS
    const before = this.count()
    await this.db.run(`DELETE FROM usage_pool_samples WHERE ts < ?`, [cutoff])
    return before - this.count()
  }

  /** Total rows. Small helper, used by `prune` and by tests. */
  count(): number {
    const row = this.db
      .prepare<{ n: number }, []>(`SELECT COUNT(*) AS n FROM usage_pool_samples`)
      .get()
    return row?.n ?? 0
  }

  /** The newest sample for a pool, or null when the series is empty. */
  latest(pool: UsagePool): UsageSample | null {
    const row = this.db
      .prepare<UsageSample, [string]>(
        `SELECT ts, pool, account_label, session, weekly, session_reset_at, weekly_reset_at
           FROM usage_pool_samples WHERE pool = ? ORDER BY ts DESC LIMIT 1`,
      )
      .get(pool)
    return row ?? null
  }

  /**
   * The dashboard's answer for one pool.
   *
   * Returns a summary with null windows rather than null itself when the series is
   * empty, so a client renders "no readings yet" instead of an error — a dashboard
   * whose first render is a failure state teaches the owner to distrust it.
   */
  summarise(pool: UsagePool): PoolSummary {
    const latest = this.latest(pool)
    if (latest === null) {
      return { pool, measured_at: null, account_label: null, session: null, weekly: null }
    }
    const now = this.now()
    return {
      pool,
      measured_at: latest.ts,
      account_label: latest.account_label,
      session: summariseWindow(latest.session, latest.session_reset_at, SESSION_WINDOW_MS, now),
      weekly: summariseWindow(latest.weekly, latest.weekly_reset_at, WEEKLY_WINDOW_MS, now),
    }
  }
}

/** Coerce to a finite number, or null. A NaN in the series is worse than a gap. */
function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
