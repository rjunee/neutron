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
 * ── THIS FILE NEVER READS THE RENDER CLOCK, AND THAT IS STRUCTURAL ──────────
 * Nothing summarised here is a function of "now": not the age of a reading, not
 * whether it is stale, not whether a gauge should be floored, not whether an
 * account has capacity. Every one of those is a DELTA, and a delta computed when
 * the response is built is already wrong when it paints — a client that holds a
 * payload (and both of ours do, between fetches) would render a dead poller as
 * permanently fresh while its own countdown kept ticking beside it. So the wire
 * carries only facts that do not age — the measurement instant, the window
 * lengths, the reset instants, and the pace/projection anchored at the
 * measurement — plus {@link POOL_STALE_AFTER_MS}, a THRESHOLD rather than a
 * verdict. The clients turn those into age, staleness, floors and capacity
 * against their own clock, on every paint. `summariseWindow` does not even take a
 * `now` parameter, which is the point: this code cannot bake a delta because it
 * cannot see the clock.
 *
 * The policy those deltas feed — "a stale reading proves only a lower bound", "an
 * account's standing is the WORST of its windows" — lives with the clock, in
 * `landing/chat-react/usage-dashboard-client.ts` and its `app/lib` twin, executed
 * side by side by `gateway/__tests__/usage-dashboard-client-parity.test.ts`.
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
  /**
   * Epoch MS the window resets, when upstream said. THE INSTANT, not a delta, and
   * deliberately the ONLY thing on the wire about when this window rolls: there is
   * no `resets_in_ms` companion, because a duration on the wire is a countdown
   * frozen at response time and the client would have no way to tell it apart from
   * a live one.
   */
  reset_at: number | null
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
}

/** One account's standing inside a pool. One card chip per entry. */
export interface AccountSummary {
  /** The account, when something can name it. NEVER guessed. */
  account_label: string | null
  /**
   * Epoch MS of this account's newest sample. THE INSTANT the age chip is
   * subtracted from at paint — there is no `age_ms` on the wire, because an age
   * baked at response time reads as "just now" forever on an open tab.
   */
  measured_at: number
  session: WindowSummary | null
  weekly: WindowSummary | null
}

/** One pool's slice of the dashboard, as the series knows it. */
export interface PoolSampleSummary {
  pool: UsagePool
  /** Newest sample across accounts, or null when the series is empty. */
  measured_at: number | null
  /**
   * How old a reading of this pool may get before it is STALE — a threshold, not
   * a verdict, so it stays true however long the client holds the payload. See
   * {@link POOL_STALE_AFTER_MS}.
   */
  stale_after_ms: number
  /** Newest sample first — the actively-probed account leads. */
  accounts: AccountSummary[]
}

/**
 * WHY A CARD IS EMPTY, in the vocabulary `UsageUnavailableReason` already uses for
 * the meter. Every value here is a DIFFERENT FIX, which is the point: an empty card
 * that cannot say which of these it is sends the owner to fix the wrong thing, or —
 * worse — to wait for a first reading that is never coming.
 */
export type UsagePoolConnection =
  /** A credential is configured and can be metered. Empty = no reading YET. */
  | 'connected'
  /** Nothing is configured for this provider. */
  | 'not_connected'
  /** Configured, but this credential has no subscription window to read. */
  | 'no_meter'
  /**
   * Configured, and THIS BUILD SHIPS NO GAUGE FOR IT — the provider's poller has
   * not landed yet.
   *
   * The distinction from `connected` is the same one `unreadable` draws, one step
   * earlier: "no readings yet" promises a first reading is coming, and for a pool
   * with no writer in the binary that is a promise nothing can keep. Codex is the
   * live case — its credential resolves, its gauge is a later phase — and a card
   * that said "No readings yet." would have the owner waiting on a poller that does
   * not exist. Unlike `unreadable` it is not a fault: nothing is misconfigured and
   * there is nothing to go and fix.
   *
   * IT DISAPPEARS BY DELETION. When a provider's poller lands, its composer arm
   * stops returning this and the state is simply unreachable for that pool — there
   * is no flag to unset and no second code path to remove.
   */
  | 'no_gauge'
  /**
   * Configured, the gauge was asked, and the answer could not be turned into a
   * reading — the key was rejected, or the payload was in a shape this build does
   * not understand.
   *
   * A SEPARATE STATE BECAUSE IT DOES NOT RESOLVE ITSELF, and that is exactly what
   * "connected, no readings yet" implies. Kimi's usages schema is unpublished, so a
   * refused payload is the realistic first-install failure: without this the card
   * would say "No readings yet." forever while the poller logged the key names to a
   * file nobody is watching. A transient error (dropped packet, 5xx) is NOT this —
   * the next tick retries and the card stays `connected`.
   */
  | 'unreadable'

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
 * ONE MISSED PROBE IS NOT A DEAD POLLER.
 *
 * A deadline set exactly at the cadence blanks an account with headroom the first
 * time a single probe fails — and a probe that fails writes no row, so the account
 * would read "unknown" for a whole cadence over one flaky request. Two cadences is
 * the smallest grace that survives one miss and still catches a writer that has
 * actually stopped, at the cost of one extra cadence of delay in saying so. The
 * cost is bounded because the age chip is on the card the entire time: the card
 * never claims freshness it does not have, it only declines to escalate for one
 * more interval.
 */
const STALE_GRACE_MULTIPLE = 2

/**
 * AND THE CLIENT HOLDS THE PAYLOAD, so the grace has to pay for that too.
 *
 * The deadline is checked against `now − measured_at` on the CLIENT, against a
 * payload it refetches every `USAGE_POLL_MS` (30 s, both clients). So a row can be
 * written and still be up to one poll interval away from being on screen. Budget
 * cadence × grace ALONE and that hold comes straight out of the grace: rows at
 * t=0, t=60 and t=180 (one missed probe at t=120) with a 120 s deadline paint the
 * card stale from t=181 until the next fetch lands the t=180 row — up to ~29 s of
 * "stale" on an install that has already recovered, which falsifies the property
 * this whole arrangement exists for ("a healthy install can only be painted stale
 * by something actually wrong").
 *
 * PINNED, NOT COPIED: the parity test in `gateway/__tests__` asserts this equals
 * `USAGE_POLL_MS` in both clients. `persistence` cannot import a client — that is
 * the layering rule — so the two are held together by a test rather than by an
 * import, the same way the cadences above are.
 */
export const CLIENT_POLL_BUDGET_MS = 30_000

/**
 * How old a reading may get before it is stale, per pool. NEVER null: a pool with
 * no deadline is a pool whose oldest reading claims "available now" forever.
 *
 * `codex` is the reason this record is separate from {@link POOL_CADENCE_MS}. It
 * has no cadence — its gauge is HARVESTED from real `codex` runs rather than
 * polled — but "no cadence" must not become "never stale", which would let a
 * three-week-old harvested reading render as current beside a "21d ago" chip. So
 * an unpolled pool gets a flat MAX AGE instead: past it, the reading is floored
 * and its standing is unknown, exactly as a missed poll would be. It needs no poll
 * budget: 30 minutes is already sixty times the client's hold.
 */
export const POOL_STALE_AFTER_MS: Record<UsagePool, number> = {
  anthropic: 60_000 * STALE_GRACE_MULTIPLE + CLIENT_POLL_BUDGET_MS,
  kimi: 10 * 60_000 * STALE_GRACE_MULTIPLE + CLIENT_POLL_BUDGET_MS,
  // Thirty minutes: the interval within which a busy `codex` session can move a
  // window materially, and sixty times the client's own poll hold. NOT derived from
  // any window LENGTH — an earlier comment here claimed "half the shortest window
  // anyone meters", which computes to 150 minutes against the 5-hour session window
  // above and would invite a future reader to loosen this five-fold. It is a
  // harvest-freshness bound, and the test pins the constant, not the derivation.
  codex: 30 * 60_000,
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

/** Keep a month. Pruned by the writers' own ticks — see the migration. */
export const USAGE_SAMPLE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * A utilisation reading in this repo's units, or null. THE UNIT INTERVAL IS THE
 * WHOLE CONTRACT, and it is checked HERE because this is the boundary every writer
 * crosses.
 *
 * `Number.isFinite` alone is not the check it looks like. A NEGATIVE fraction is
 * finite, and it survives all the way to the paint: pace is `fraction / elapsed`,
 * so −0.02 over a tenth of a window renders as "−0.2× — within the refill rate", a
 * sentence that is simultaneously confident, reassuring and meaningless. The Kimi
 * parser already refuses negatives at its own edge (`trident/kimi-usage-probe.ts`),
 * but the Anthropic header path does not: `numberHeader` in
 * `auth/credential-usage-probe.ts` returns any finite parse, so a header carrying
 * `-1` (an upstream sentinel for "unknown" is exactly the shape that produces one)
 * arrives here intact. One writer's guard is not the property; a boundary check is.
 *
 * ABOVE 1 IS REFUSED FOR THE SAME REASON AND NOT CLAMPED. A reading of 64 where a
 * fraction was expected is a percent under a fraction's name — a 100× unit error —
 * and clamping it to 1.0 turns an unreadable field into a confident "fully spent".
 * Refusing leaves the window unsummarised, which the card renders as a window it
 * could not read rather than as a number nobody measured.
 */
export function utilisationOrNull(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  if (v < 0 || v > 1) return null
  return v
}

/**
 * Summarise one window from a reading plus the clock.
 *
 * PURE, so every branch is testable without a database: the interesting behaviour here
 * is which cases refuse to answer, and those are exactly the ones a rendered dashboard
 * makes hard to see.
 *
 * ONE CLOCK, AND IT IS NOT THE RENDER CLOCK. There is no `now` parameter, on
 * purpose: everything computed here is anchored at `measured_at`, because the
 * fraction was true then. Pace computed against a fresh `now` silently deflates as
 * a sample ages — the same reading would report a calmer and calmer burn the
 * longer the writer had been dead — and anything else this function could derive
 * from `now` (the countdown, the age, the staleness, the floor) is a delta that
 * has to be recomputed on every paint, so it belongs to the clients and not here.
 */
export function summariseWindow(input: {
  fraction: number | null
  reset_at: number | null
  /** The sample's own length when it reported one, else the pool default. */
  window_ms: number | null
  /** When the fraction was measured. */
  measured_at: number
}): WindowSummary | null {
  const { reset_at, window_ms, measured_at } = input
  // Re-checked on the READ side too, not only on the write: rows written by an
  // earlier build are already on disk, and this function is what every card renders
  // from. See {@link utilisationOrNull}.
  const fraction = utilisationOrNull(input.fraction)
  if (fraction === null) return null
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
  return { fraction, window_ms, reset_at, pace, exhausts_at }
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
    // A utilisation outside [0, 1] is not a reading, so it is not stored. Dropping
    // it here keeps the series clean for anything that reads the rows directly;
    // `summariseWindow` refuses the same values again for rows already on disk.
    const session = utilisationOrNull(input.session)
    const weekly = utilisationOrNull(input.weekly)
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
    const defaults = POOL_WINDOW_DEFAULT_MS[pool]
    const accounts: AccountSummary[] = this.latestPerAccount(pool).map((sample) => ({
      account_label: sample.account_label,
      measured_at: sample.ts,
      session: summariseWindow({
        fraction: sample.session,
        reset_at: sample.session_reset_at,
        window_ms: sample.session_window_ms ?? defaults.session,
        measured_at: sample.ts,
      }),
      weekly: summariseWindow({
        fraction: sample.weekly,
        reset_at: sample.weekly_reset_at,
        window_ms: sample.weekly_window_ms ?? defaults.weekly,
        measured_at: sample.ts,
      }),
    }))
    return {
      pool,
      // The NEWEST account leads (`latestPerAccount` orders by ts), so this is the
      // freshest thing the pool knows. Null when nothing was ever measured, which
      // the card renders as "never measured" rather than as an age of zero.
      measured_at: accounts.length === 0 ? null : accounts[0]!.measured_at,
      stale_after_ms: POOL_STALE_AFTER_MS[pool],
      accounts,
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
