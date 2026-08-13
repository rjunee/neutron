/**
 * @neutronai/persistence — the usage-sample series, and the maths read off it.
 *
 * The monitors measure every quota pool this instance can see and used to discard
 * every reading. This keeps them, so the product can answer the two questions a
 * single number cannot:
 *
 *   - **"is this going to run out before it resets, and when"** — PACE.
 *     `pace = fraction consumed ÷ fraction of the window elapsed`. Above 1 means
 *     burning faster than the window refills.
 *   - **"when does capacity COME BACK"** — the RESET COUNTDOWN. The opposite
 *     question, and the one that decides whether to push concurrency up. Pace says
 *     when you hit the wall; the countdown says when the wall moves.
 *
 * Both are computed HERE rather than stored, because a stored derivative goes stale
 * the moment the formula improves — and, for the countdown, the moment after it is
 * written. **STORE THE INSTANT, RENDER THE DELTA:** every reset is persisted as an
 * absolute epoch-MS instant and every countdown is a subtraction at render time. A
 * cached "17m" that renders an hour later is a confidently precise lie.
 *
 * ── A COUNTDOWN ALONE IS MISLEADING, SO NOTHING HERE EMITS ONE ALONE ────────
 * The two windows reset independently. An account whose 5-hour window resets in 17
 * minutes but whose 7-day window is 96% spent has almost no capacity coming back,
 * and a headline reading "next capacity in 17m" would send the owner to raise
 * concurrency into a wall. So every window's countdown travels with that window's
 * own utilisation, and an ACCOUNT's standing is the WORST of its windows
 * ({@link accountCapacity}) — never the soonest reset.
 *
 * ── NEVER OPTIMISTIC ─────────────────────────────────────────────────────────
 * Three refusals are load-bearing and each has a test:
 *   - an absent reset instant is `unknown`, never "now" and never omitted;
 *   - a STALE reading that says "plenty left" cannot claim availability — usage
 *     only climbs between samples, so the honest answer is `unknown`;
 *   - a stale reading that says "spent" still yields a countdown, because "more
 *     used than this" cannot become "less used than this" inside one window.
 */

import type { ProjectDb } from './db.ts'

/**
 * Which quota pool a sample describes.
 *
 * `codex` has no writer in this phase — its gauge is harvested from real `codex`
 * runs, which lands with the lane writers. It is enumerated anyway so the surface
 * renders it as "not connected / no samples yet" rather than omitting it, because
 * a missing card and an idle card are different facts to an owner deciding where
 * to send the next build.
 */
export type UsagePool = 'anthropic' | 'codex' | 'kimi'

/**
 * Every pool the dashboard renders, in render order: the two that have writers
 * today first. Exported so the composer cannot enumerate a different set than the
 * store knows about — one list, one order, both clients.
 */
export const USAGE_POOLS: readonly UsagePool[] = ['anthropic', 'kimi', 'codex']

/** Which of the two windows a figure describes. */
export type UsageWindowKey = 'session' | 'weekly'

/** One persisted reading. Fractions are 0..1; every field may be absent upstream. */
export interface UsageSample {
  ts: number
  pool: UsagePool
  /** The account behind the reading, when anything can name it. Often null. */
  account_label: string | null
  session: number | null
  weekly: number | null
  session_reset_at: number | null
  weekly_reset_at: number | null
  /** How long the window was, as the provider reported it. Null = not reported. */
  session_window_ms: number | null
  weekly_window_ms: number | null
}

/** What the dashboard needs about one window. */
export interface WindowSummary {
  /** Fraction consumed, 0..1, from this account's newest sample. */
  fraction: number
  /**
   * The window length used to summarise this reading — the sample's own when the
   * provider reported one, else the pool default. Null when neither exists, which
   * is why `pace` can be null on a window whose fraction is known.
   */
  window_ms: number | null
  /** Epoch MS the window resets, when upstream said. THE INSTANT, not a delta. */
  reset_at: number | null
  /**
   * Milliseconds until the reset AS OF THIS RESPONSE, or null when unknown.
   *
   * Convenience only. A client that holds a payload for an hour must recompute
   * from `reset_at` and its own clock — that is the whole reason the instant is
   * on the wire.
   */
  resets_in_ms: number | null
  /**
   * Consumed ÷ elapsed, over this window, AS OF THE MEASUREMENT. `null` when it
   * cannot be computed — an unknown reset time, an unknown window length, or a
   * window that has only just started (dividing by a near-zero elapsed fraction
   * produces a number that says nothing).
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
  /**
   * True when this fraction is a LOWER BOUND rather than a current reading: the
   * sample is older than the pool's cadence and the window has not reset since it
   * was taken, so consumption can only have climbed. Rendered as "≥ 43%" with the
   * age, which is the locked posture — floor a stale gauge with its age rather
   * than blanking it or extrapolating past it.
   */
  floor: boolean
}

/**
 * When an account can take work again.
 *
 * A DISCRIMINATED UNION rather than a nullable number, deliberately. The
 * catastrophic render here is "unknown" drawn as "now" — it sends the owner to
 * raise concurrency into a wall — and a `number | null` field invites exactly
 * that: `0` and `null` are one `if (!ms)` apart. With a tagged state, a client
 * that has not handled `unknown` cannot accidentally render it as availability.
 */
export type CapacityStanding =
  /** Has room right now, measured recently enough to say so. */
  | { state: 'available' }
  /** Spent; capacity returns at this instant, on this window. */
  | { state: 'returns'; at: number; window: UsageWindowKey }
  /** Cannot be known: no reset instant, or a reading too old to claim room from. */
  | { state: 'unknown' }

/** One account's standing inside a pool. One card chip per entry. */
export interface AccountSummary {
  /** The account, when something can name it. NEVER guessed. */
  account_label: string | null
  /** Epoch MS of this account's newest sample. */
  measured_at: number
  /** How old that sample is, as of this response. */
  age_ms: number
  /** True when the sample is older than this pool's expected cadence. */
  stale: boolean
  session: WindowSummary | null
  weekly: WindowSummary | null
  /**
   * Which window decides this account's capacity — the one whose standing is
   * worst. Null when nothing is known. This is the field that stops "the 5-hour
   * window resets in 17m" from being reported as capacity when the 7-day window
   * is the actual constraint.
   */
  binding: UsageWindowKey | null
  capacity: CapacityStanding
}

/** The pool-level headline: "how hard can I push, right now?" */
export interface PoolCapacity {
  /** Accounts with room right now. */
  available_now: number
  /** Accounts that are spent but whose capacity returns at a known instant. */
  returning: number
  /** Accounts whose standing cannot be known. NEVER counted as available. */
  unknown: number
  /** The account the headline is about — the first one to have capacity. */
  next_account_label: string | null
  /** That account's standing. The line renders this, and nothing else. */
  next: CapacityStanding
  /**
   * The OTHER window on that account, so the headline can name what still binds:
   * "next capacity in 17m (5h window; 7d window 64% used)". Null when there is no
   * second window to report.
   */
  next_other_window: UsageWindowKey | null
  next_other_fraction: number | null
}

/** One pool's slice of the dashboard, as the series knows it. */
export interface PoolSampleSummary {
  pool: UsagePool
  /** Newest sample across accounts, or null when the series is empty. */
  measured_at: number | null
  /** Age of that newest sample, or null when there is none. */
  age_ms: number | null
  /** Newest sample first — the actively-probed account leads. */
  accounts: AccountSummary[]
  capacity: PoolCapacity
}

/**
 * Whether this pool has a credential at all, in the vocabulary
 * `UsageUnavailableReason` already uses for the meter: a pool with no credential
 * and a pool whose credential carries no windows are different facts with
 * different fixes, and neither is "connected and idle".
 */
export type UsagePoolConnection =
  /** A credential is configured and can be metered. */
  | 'connected'
  /** Nothing is configured for this provider. */
  | 'not_connected'
  /** Configured, but this credential has no subscription window to read. */
  | 'no_meter'

/** What `GET /api/app/usage/dashboard` serves per pool. */
export interface PoolSummary extends PoolSampleSummary {
  /**
   * Supplied by the composer from the SAME resolvers the rest of the product
   * uses, so a card that has never been sampled can say WHY. An empty card that
   * cannot distinguish "no key" from "key, no readings yet" sends the owner to
   * fix the wrong thing.
   */
  connection: UsagePoolConnection
}

/**
 * How long each pool's windows last when the provider did not say.
 *
 * Per pool, never one global constant: 5h/7d is Anthropic's regime and nobody
 * else's. Codex reports its own `window_minutes` per sample (it has already
 * changed once), and Kimi's is read off its usages endpoint — for both, an absent
 * length means pace is refused rather than computed against a borrowed constant.
 */
const POOL_WINDOW_DEFAULT_MS: Record<
  UsagePool,
  { session: number | null; weekly: number | null }
> = {
  anthropic: { session: 5 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 },
  codex: { session: null, weekly: null },
  kimi: { session: null, weekly: null },
}

/**
 * How often each pool is expected to produce a sample. A reading older than this
 * is STALE — shown with its age and floored, never blanked and never treated as
 * current (locked decision: staleness is shown, never hidden).
 *
 * These mirror the writers' own poll intervals (`open/credential-usage-monitor.ts`,
 * `open/kimi-usage-monitor.ts`); `open/__tests__/usage-dashboard-wiring.test.ts`
 * pins the pairs so the two cannot drift. `codex` is null because its gauge is
 * harvested from real runs rather than polled: there is no cadence to violate, so
 * its age is reported and never converted into a staleness claim.
 */
export const POOL_CADENCE_MS: Record<UsagePool, number | null> = {
  anthropic: 60_000,
  kimi: 10 * 60_000,
  codex: null,
}

/**
 * Below this fraction elapsed, pace is reported as null.
 *
 * Two minutes into a five-hour window, one turn's worth of usage divides by ~0.007 and
 * produces a pace in the hundreds. That number is arithmetically correct and completely
 * misleading — it says "you will run out in minutes" about a window that has barely
 * started. Refusing to answer is the honest response to a sample size of one.
 */
const MIN_ELAPSED_FRACTION = 0.05

/**
 * Headroom at or below which a window counts as SPENT.
 *
 * Not zero, on purpose. The question this feature answers is "can I push more
 * concurrency into this account", and 1% of a weekly window is not capacity you
 * can push into — calling it available is the optimistic answer the owner
 * explicitly does not want. Erring this way is safe in the only direction that
 * matters: the cost of calling a nearly-spent account spent is one build routed
 * elsewhere; the cost of the reverse is a wall.
 */
const SPENT_HEADROOM_FRACTION = 0.05

/** Keep a month. Pruned by the writers' own ticks — see the migration. */
export const USAGE_SAMPLE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Summarise one window from a reading plus the clock.
 *
 * PURE, so every branch is testable without a database: the interesting behaviour here
 * is which cases refuse to answer, and those are exactly the ones a rendered dashboard
 * makes hard to see.
 *
 * TWO CLOCKS, and mixing them is the bug this signature exists to prevent.
 * `measured_at` anchors everything derived FROM the fraction (pace, and the
 * projection off it), because the fraction was true then; `now` anchors only the
 * countdown, because a reset instant is a fact about the future that does not age.
 * Computing pace with a fresh `now` against a stale fraction silently deflates it
 * as the sample ages — the same reading reports a calmer and calmer burn the
 * longer the writer has been dead.
 */
export function summariseWindow(input: {
  fraction: number | null
  reset_at: number | null
  /** The sample's own length when it reported one, else the pool default. */
  window_ms: number | null
  /** When the fraction was measured. */
  measured_at: number
  /** The render clock. */
  now: number
  /** Whether the sample is older than its pool's cadence. */
  stale: boolean
}): WindowSummary | null {
  const { fraction, reset_at, window_ms, measured_at, now, stale } = input
  if (fraction === null || !Number.isFinite(fraction)) return null
  const resets_in_ms = reset_at !== null ? reset_at - now : null
  let pace: number | null = null
  if (reset_at !== null && window_ms !== null && window_ms > 0) {
    // The window STARTED one window-length before it resets, so elapsed is measured
    // back from the reset rather than from any timestamp we hold — the upstream reset
    // time is the only anchor we actually get.
    const started_at = reset_at - window_ms
    const elapsed = (measured_at - started_at) / window_ms
    if (elapsed >= MIN_ELAPSED_FRACTION && elapsed <= 1) {
      pace = fraction / elapsed
    }
  }
  let exhausts_at: number | null = null
  if (pace !== null && pace > 1 && fraction < 1 && window_ms !== null) {
    // DERIVED, not guessed. `pace` is fraction-consumed per fraction-of-window
    // elapsed — i.e. the consumption RATE in window-fraction units. So the time left
    // to consume `1 - fraction` is `(1 - fraction) / pace` window-fractions, which is
    // that times `window_ms` in real time.
    //
    // A first draft here divided by pace twice (`… / pace * … * 1 / pace`), which is
    // arithmetically wrong and completely plausible-looking — it would have projected
    // exhaustion far too early on every fast window. The test below pins a
    // hand-checkable case for exactly that reason.
    //
    // Anchored at `measured_at`, for the same reason pace is: the projection is a
    // statement about the reading, so a stale reading projects from when it was
    // taken. Anchoring it at `now` would slide the projected cap-out forward every
    // second a dead writer stays dead, which reads as a window that keeps healing.
    exhausts_at = Math.round(measured_at + ((1 - fraction) / pace) * window_ms)
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
  // A stale reading is a floor only while the window it describes is still running.
  // Once the reset instant has passed the window has rolled and consumption started
  // again from zero, so "at least this much" stops being true — and claiming it
  // would overstate usage on exactly the account that just freed up.
  const floor = stale && reset_at !== null && reset_at > now
  return { fraction, window_ms, reset_at, resets_in_ms, pace, exhausts_at, floor }
}

/**
 * What one window says about capacity.
 *
 * THE POLICY IS "WHAT DOES THIS READING STILL PROVE", and every branch refuses to
 * be optimistic:
 *
 * A STALE reading proves exactly ONE thing: that its window was at least this
 * spent, and only while that same window is still running — inside one window
 * "at least this used" cannot become "less used". So a stale reading yields a
 * countdown when it says SPENT, and `unknown` otherwise. In particular a stale
 * reading whose window has since ROLLED proves nothing at all: consumption
 * restarted and nobody measured what happened next, and calling that "available"
 * would be a dead poller reading as an idle account.
 *
 * A FRESH reading is believed:
 *   - the reset instant has PASSED → the window rolled moments ago and
 *     consumption restarted: available;
 *   - SPENT (headroom at or below the floor) → capacity returns at the reset,
 *     or `unknown` when no instant was reported — never "now";
 *   - room → available.
 */
export function windowCapacity(
  win: WindowSummary | null,
  window: UsageWindowKey,
  now: number,
  stale: boolean,
): CapacityStanding | null {
  if (win === null) return null
  const rolled = win.reset_at !== null && win.reset_at <= now
  const spent = 1 - win.fraction <= SPENT_HEADROOM_FRACTION
  if (stale) {
    if (!rolled && spent && win.reset_at !== null) {
      return { state: 'returns', at: win.reset_at, window }
    }
    return { state: 'unknown' }
  }
  if (rolled) return { state: 'available' }
  if (spent) {
    return win.reset_at === null
      ? { state: 'unknown' }
      : { state: 'returns', at: win.reset_at, window }
  }
  return { state: 'available' }
}

/**
 * How long until this standing yields capacity, for ordering only.
 *
 * `unknown` sorts LAST rather than first: an account nobody can vouch for is not
 * the one to point the owner at.
 */
function capacityRank(standing: CapacityStanding): number {
  if (standing.state === 'available') return Number.NEGATIVE_INFINITY
  if (standing.state === 'returns') return standing.at
  return Number.POSITIVE_INFINITY
}

/**
 * An account's standing is the WORST of its windows, and that is the whole point.
 *
 * Capacity requires room in EVERY window, so a 5-hour window resetting in 17
 * minutes buys nothing if the 7-day window is spent for another three days. Taking
 * the worst is what makes the pool headline safe to act on; taking the soonest
 * reset is the bug this function exists to make impossible.
 */
export function accountCapacity(
  session: WindowSummary | null,
  weekly: WindowSummary | null,
  now: number,
  stale: boolean,
): { binding: UsageWindowKey | null; capacity: CapacityStanding } {
  const candidates: Array<{ window: UsageWindowKey; standing: CapacityStanding }> = []
  const s = windowCapacity(session, 'session', now, stale)
  if (s !== null) candidates.push({ window: 'session', standing: s })
  const w = windowCapacity(weekly, 'weekly', now, stale)
  if (w !== null) candidates.push({ window: 'weekly', standing: w })
  if (candidates.length === 0) return { binding: null, capacity: { state: 'unknown' } }
  const headroom = (w: UsageWindowKey): number => {
    const win = w === 'session' ? session : weekly
    return win === null ? 1 : 1 - win.fraction
  }
  let worst = candidates[0]!
  for (const c of candidates.slice(1)) {
    const rank = capacityRank(c.standing)
    const worstRank = capacityRank(worst.standing)
    // Equal standings — two available windows, or two resetting at the same
    // instant — are broken by HEADROOM, so `binding` still names the window that
    // is closest to constraining this account. Left to declaration order it would
    // name whichever window happened to be checked first, and the headline would
    // then report the roomier window as the constraint.
    if (rank > worstRank || (rank === worstRank && headroom(c.window) < headroom(worst.window))) {
      worst = c
    }
  }
  return { binding: worst.window, capacity: worst.standing }
}

/** The pool headline: the first account to have capacity, and what still binds it. */
function poolCapacity(accounts: AccountSummary[]): PoolCapacity {
  const empty: PoolCapacity = {
    available_now: 0,
    returning: 0,
    unknown: 0,
    next_account_label: null,
    next: { state: 'unknown' },
    next_other_window: null,
    next_other_fraction: null,
  }
  if (accounts.length === 0) return empty
  let available_now = 0
  let returning = 0
  let unknown = 0
  for (const a of accounts) {
    if (a.capacity.state === 'available') available_now += 1
    else if (a.capacity.state === 'returns') returning += 1
    else unknown += 1
  }
  let best = accounts[0]!
  for (const a of accounts.slice(1)) {
    if (capacityRank(a.capacity) < capacityRank(best.capacity)) best = a
  }
  // The window that did NOT bind — the one the headline names as the remaining
  // constraint ("… 7d window 64% used"). Reported by its utilisation, not by its
  // reset, because "how much is left over there" is the thing the countdown alone
  // could not say.
  const other: UsageWindowKey | null =
    best.binding === null ? null : best.binding === 'session' ? 'weekly' : 'session'
  const other_summary = other === null ? null : other === 'session' ? best.session : best.weekly
  return {
    available_now,
    returning,
    unknown,
    next_account_label: best.account_label,
    next: best.capacity,
    next_other_window: other_summary === null ? null : other,
    next_other_fraction: other_summary === null ? null : other_summary.fraction,
  }
}

export class UsageSamplesStore {
  private readonly db: ProjectDb
  private readonly now: () => number

  constructor(deps: { db: ProjectDb; now?: () => number }) {
    this.db = deps.db
    this.now = deps.now ?? ((): number => Date.now())
  }

  /**
   * Record one reading. Idempotent on (ts, pool, account).
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
    session_window_ms?: number | null
    weekly_window_ms?: number | null
  }): Promise<boolean> {
    const session = numberOrNull(input.session)
    const weekly = numberOrNull(input.weekly)
    if (session === null && weekly === null) return false
    const ts = input.ts ?? this.now()
    // '' is the "nothing can name this account" key, never a name. See the 0121
    // migration for why the absence has to be spellable in a primary key.
    const label =
      typeof input.account_label === 'string' && input.account_label.trim().length > 0
        ? input.account_label.trim()
        : ''
    await this.db.run(
      `INSERT INTO usage_pool_samples
         (ts, pool, account_label, session, weekly, session_reset_at, weekly_reset_at,
          session_window_ms, weekly_window_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ts, pool, account_label) DO UPDATE SET
         session = excluded.session,
         weekly = excluded.weekly,
         session_reset_at = excluded.session_reset_at,
         weekly_reset_at = excluded.weekly_reset_at,
         session_window_ms = excluded.session_window_ms,
         weekly_window_ms = excluded.weekly_window_ms`,
      [
        ts,
        input.pool,
        label,
        session,
        weekly,
        numberOrNull(input.session_reset_at),
        numberOrNull(input.weekly_reset_at),
        numberOrNull(input.session_window_ms),
        numberOrNull(input.weekly_window_ms),
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

  /** The newest sample for a pool, whichever account it belongs to. */
  latest(pool: UsagePool): UsageSample | null {
    const row = this.db
      .prepare<RawSample, [string]>(
        `SELECT ${SAMPLE_COLUMNS}
           FROM usage_pool_samples WHERE pool = ? ORDER BY ts DESC LIMIT 1`,
      )
      .get(pool)
    return row === null || row === undefined ? null : decodeSample(row)
  }

  /**
   * The newest sample PER ACCOUNT, newest account first.
   *
   * This is what makes a non-active account's headroom renderable without probing
   * it: the series keeps every account it has ever seen, so the card can show what
   * account B's weekly window looked like when it was last measured, with its age,
   * instead of the blank that reads as "no usage".
   */
  latestPerAccount(pool: UsagePool): UsageSample[] {
    const rows = this.db
      .prepare<RawSample, [string, string]>(
        `SELECT ${SAMPLE_COLUMNS}
           FROM usage_pool_samples s
           JOIN (
             SELECT account_label AS k, MAX(ts) AS mts
               FROM usage_pool_samples WHERE pool = ? GROUP BY account_label
           ) m ON s.account_label = m.k AND s.ts = m.mts
          WHERE s.pool = ?
          ORDER BY s.ts DESC`,
      )
      .all(pool, pool)
    return rows.map(decodeSample)
  }

  /**
   * The dashboard's answer for one pool.
   *
   * Returns a summary with no accounts rather than null when the series is empty, so
   * a client renders "no readings yet" instead of an error — a dashboard whose first
   * render is a failure state teaches the owner to distrust it.
   */
  summarise(pool: UsagePool): PoolSampleSummary {
    const now = this.now()
    const cadence = POOL_CADENCE_MS[pool]
    const defaults = POOL_WINDOW_DEFAULT_MS[pool]
    const accounts: AccountSummary[] = this.latestPerAccount(pool).map((sample) => {
      const age_ms = now - sample.ts
      const stale = cadence !== null && age_ms > cadence
      const session = summariseWindow({
        fraction: sample.session,
        reset_at: sample.session_reset_at,
        window_ms: sample.session_window_ms ?? defaults.session,
        measured_at: sample.ts,
        now,
        stale,
      })
      const weekly = summariseWindow({
        fraction: sample.weekly,
        reset_at: sample.weekly_reset_at,
        window_ms: sample.weekly_window_ms ?? defaults.weekly,
        measured_at: sample.ts,
        now,
        stale,
      })
      const { binding, capacity } = accountCapacity(session, weekly, now, stale)
      return {
        account_label: sample.account_label,
        measured_at: sample.ts,
        age_ms,
        stale,
        session,
        weekly,
        binding,
        capacity,
      }
    })
    const measured_at = accounts.length === 0 ? null : accounts[0]!.measured_at
    return {
      pool,
      measured_at,
      age_ms: measured_at === null ? null : now - measured_at,
      accounts,
      capacity: poolCapacity(accounts),
    }
  }
}

/**
 * Every column both reads project, named once so the two queries cannot drift
 * apart. Unqualified on purpose — the join below exposes only `k` and `mts` from
 * its subquery, so nothing here is ambiguous.
 */
const SAMPLE_COLUMNS = `ts, pool, account_label, session, weekly,
         session_reset_at, weekly_reset_at, session_window_ms, weekly_window_ms`

interface RawSample extends Omit<UsageSample, 'account_label'> {
  account_label: string
}

/** '' is the stored absence of a label; nothing above this line ever sees it. */
function decodeSample(row: RawSample): UsageSample {
  return { ...row, account_label: row.account_label === '' ? null : row.account_label }
}

/** Coerce to a finite number, or null. A NaN in the series is worse than a gap. */
function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
