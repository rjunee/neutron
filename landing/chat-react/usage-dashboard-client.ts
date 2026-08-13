/**
 * landing/chat-react — the usage-dashboard client.
 *
 *   GET /api/app/usage/dashboard → { pools: [ { accounts, stale_after_ms, … } ] }
 *
 * The meter in the divider answers "how full is the window". This answers the two
 * questions a single reading cannot, and they are opposites:
 *
 *   - **is it going to run out before it resets** — pace and the projected cap;
 *   - **when does capacity come back** — the countdown to each window's reset,
 *     and the pool line that reads off it.
 *
 * ── EVERY DELTA IS COMPUTED HERE, ON EVERY PAINT ─────────────────────────────
 * The payload carries only facts that DO NOT AGE: the instant each reading was
 * taken, each window's length and reset instant, the pace and projection anchored
 * at the measurement, and `stale_after_ms` — a THRESHOLD, not a verdict. This file
 * turns those into the four things that are pure functions of the clock:
 *
 *   - the AGE of a reading (`now − measured_at`);
 *   - whether it is STALE (`age > stale_after_ms`);
 *   - whether a gauge is a FLOOR (stale, and its window has not rolled yet);
 *   - what CAPACITY an account has ({@link projectPool}).
 *
 * None of those may ride the wire, and that is the defect this shape exists to
 * make impossible: a server-computed age would read "just now" for as long as the
 * tab stayed open — a poller dead for six hours would paint as freshly measured
 * with a live countdown running beside it, which is the exact "confident fresh
 * number" the product forbids. Deltas are cheap; a wrong one is not.
 *
 * ── AND THE PAYLOAD IS REFETCHED, BECAUSE AGEING ALONE IS NOT THE ANSWER ─────
 * Computing the deltas at paint fixes the LIE; it does not fix the DATA. A screen
 * that only advanced its clock would walk a perfectly healthy install into
 * staleness: `stale_after_ms` for the Anthropic pool is two minutes, so ~2.5
 * minutes after the screen opened the card would floor its gauges to "≥" and drop
 * its standing to "unknown" while the poller behind it was writing a fresh row
 * every 60 seconds. So the screens poll on {@link USAGE_POLL_MS}, which is pinned
 * BELOW the tightest staleness deadline any pool ships — a healthy install can
 * then only ever be painted stale by something actually being wrong.
 *
 * ── NULL IS AN ANSWER, NOT A ZERO ────────────────────────────────────────────
 * Each of these is legitimately absent and each means something different:
 *
 *   - `pace: null` — refusing to answer. Either the reset time is unknown, the
 *     window length is unknown, or the window has barely started, where dividing
 *     by a near-zero elapsed fraction produces a number in the hundreds that is
 *     arithmetically correct and completely misleading. Renders as an em dash.
 *     NEVER as 0, which would read as "you are using nothing".
 *   - `exhausts_at: null` — the COMMON, GOOD case: at this pace the window
 *     refills faster than it drains, so there is nothing to project. The line is
 *     omitted entirely rather than shown empty, because an empty "caps at" row
 *     reads as a failure to compute.
 *   - `account_label: null` — no sidecar names the account behind this reading, or
 *     the one on disk describes a token the box is not holding. Renders as "active
 *     credential". It must NEVER guess a name.
 *   - `capacity: { state: 'unknown' }` — nobody can say when this account frees
 *     up. Renders as "unknown", never as "now". A missing reset rendered as
 *     available is what would send the owner to raise concurrency into a wall,
 *     which is why the standing is a tagged state rather than a nullable number.
 *
 * A rejected fetch resolves to "unreachable", never to an empty series: an older
 * gateway does not mount the route, and a client that drew "0% used" from a 404
 * would be inventing a measurement.
 */

// ── The wire ─────────────────────────────────────────────────────────────────
// Mirrors `@neutronai/persistence/usage-samples-store.ts`, re-declared rather than
// imported — the convention every client here follows, and the reason this file has
// a twin. NOTHING below is a duration relative to "now"; see the header.

/** One window's standing, as measured. */
export interface UsageWindow {
  fraction: number
  /** The window's own length, when the provider reported one. */
  window_ms: number | null
  /** THE INSTANT the window rolls. The countdown to it is computed at paint. */
  reset_at: number | null
  pace: number | null
  exhausts_at: number | null
}

export interface UsageAccount {
  account_label: string | null
  /** THE INSTANT this reading was taken. The age chip is subtracted from it. */
  measured_at: number
  session: UsageWindow | null
  weekly: UsageWindow | null
}

/** Why a pool has no readings, when it has none. */
export type UsagePoolConnection = 'connected' | 'not_connected' | 'no_meter'

export interface UsagePool {
  pool: string
  connection: UsagePoolConnection
  measured_at: number | null
  /** How old a reading of this pool may get before it is stale. A threshold. */
  stale_after_ms: number
  accounts: UsageAccount[]
}

/** What the card renders from. `reachable: false` is a display state. */
export type UsageDashboard =
  | { reachable: true; pools: UsagePool[] }
  | { reachable: false }

export const DASHBOARD_UNREACHABLE: UsageDashboard = { reachable: false }

const PATH = '/api/app/usage/dashboard'

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export interface UsageDashboardClientOptions {
  base_url: string
  token: string
  fetchImpl?: FetchImpl
}

/**
 * How stale a reading is assumed to go when the server did not say.
 *
 * DELIBERATELY SHORT, and the direction is the whole point: a missing threshold
 * must make a card MORE cautious, never less. The mirror-image bug — defaulting an
 * absent field to maximum freshness — is how a version skew turns an arbitrarily
 * old reading into a confident "just now".
 */
const FALLBACK_STALE_AFTER_MS = 5 * 60_000

/**
 * How often a mounted screen REFETCHES the payload.
 *
 * NOT A COSMETIC CADENCE — it is a correctness bound. Every gauge on the card
 * degrades on age: past `stale_after_ms` the fractions become "≥" floors and the
 * account's standing falls to "unknown". If the screen never refetched, that
 * degradation would fire on the CLOCK rather than on anything being wrong, and a
 * healthy install would paint itself broken minutes after the tab opened.
 *
 * So this must stay STRICTLY BELOW the tightest `stale_after_ms` any pool ships
 * (Anthropic's, at two minutes — `persistence/usage-samples-store.ts`), with room
 * for one dropped request. Thirty seconds gives three attempts inside that window
 * and matches the render clock, so one interval drives both and they cannot drift.
 * A parity test pins the relationship rather than the number, because the number
 * that matters is the store's.
 */
export const USAGE_POLL_MS = 30_000

/** Decode one window, or null. A field of the wrong type makes the whole window
 *  null rather than coercing: a bar drawn from a coerced NaN is a lie with a
 *  length. */
function decodeWindow(raw: unknown): UsageWindow | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  const fraction = rec['fraction']
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return null
  return {
    fraction,
    window_ms: numOrNull(rec['window_ms']),
    reset_at: numOrNull(rec['reset_at']),
    pace: numOrNull(rec['pace']),
    exhausts_at: numOrNull(rec['exhausts_at']),
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** An unusable threshold falls back to the CAUTIOUS default, never to "forever". */
function decodeStaleAfter(v: unknown): number {
  const n = numOrNull(v)
  return n !== null && n > 0 ? n : FALLBACK_STALE_AFTER_MS
}

/**
 * Decode one account, or null.
 *
 * `measured_at` is required, and it is required because everything the card says
 * about this reading is a delta from it: without the instant there is no age, no
 * staleness and no floor, and a row rendered anyway would be a reading with no
 * provenance. Refusing is the only honest option — there is no "assume it is
 * fresh" that is not a fabrication.
 */
function decodeAccount(raw: unknown): UsageAccount | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  const measured_at = numOrNull(rec['measured_at'])
  if (measured_at === null) return null
  const label = rec['account_label']
  return {
    account_label: typeof label === 'string' && label.length > 0 ? label : null,
    measured_at,
    session: decodeWindow(rec['session']),
    weekly: decodeWindow(rec['weekly']),
  }
}

function decodeConnection(v: unknown): UsagePoolConnection {
  // An unknown value decodes as `connected`, so an older or newer server never
  // makes a populated card claim "not connected" — the honest degradation is the
  // one that says nothing rather than the one that blames the owner's setup.
  return v === 'not_connected' || v === 'no_meter' || v === 'connected'
    ? (v as UsagePoolConnection)
    : 'connected'
}

export function decodeDashboard(raw: unknown): UsageDashboard {
  if (typeof raw !== 'object' || raw === null) return DASHBOARD_UNREACHABLE
  const pools = (raw as Record<string, unknown>)['pools']
  if (!Array.isArray(pools)) return DASHBOARD_UNREACHABLE
  const decoded: UsagePool[] = []
  for (const entry of pools) {
    if (typeof entry !== 'object' || entry === null) continue
    const rec = entry as Record<string, unknown>
    const pool = rec['pool']
    if (typeof pool !== 'string') continue
    const rawAccounts = rec['accounts']
    const accounts: UsageAccount[] = []
    if (Array.isArray(rawAccounts)) {
      for (const a of rawAccounts) {
        const account = decodeAccount(a)
        if (account !== null) accounts.push(account)
      }
    }
    decoded.push({
      pool,
      connection: decodeConnection(rec['connection']),
      measured_at: numOrNull(rec['measured_at']),
      stale_after_ms: decodeStaleAfter(rec['stale_after_ms']),
      accounts,
    })
  }
  // An EMPTY array is reachable-with-nothing, which is different from unreachable
  // and renders differently. Collapsing the two would hide a server that answered.
  return { reachable: true, pools: decoded }
}

export class WebUsageDashboardClient {
  private readonly base_url: string
  private readonly token: string
  private readonly fetchImpl: FetchImpl

  constructor(opts: UsageDashboardClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  /** Never rejects. Every failure is the same display state. */
  async load(signal?: AbortSignal): Promise<UsageDashboard> {
    try {
      const res = await this.fetchImpl(`${this.base_url}${PATH}`, {
        headers: { authorization: `Bearer ${this.token}` },
        ...(signal !== undefined ? { signal } : {}),
      })
      if (!res.ok) return DASHBOARD_UNREACHABLE
      return decodeDashboard(await res.json().catch(() => null))
    } catch {
      return DASHBOARD_UNREACHABLE
    }
  }
}

// ── The projection: everything that is a function of the clock ───────────────
// Pure, exported, and executed side by side with its twin by
// `gateway/__tests__/usage-dashboard-client-parity.test.ts`. This is POLICY, not
// transport — "a stale reading proves only a lower bound", "an account's standing
// is the worst of its windows" — and it lives here rather than on the server for
// one reason: it is a function of `now`, and the only clock that matters is the
// one running while the owner is looking at the card.

/** When an account can take work again. A tagged state, never a nullable number. */
export type CapacityStanding =
  /** Has room right now, measured recently enough to say so. */
  | { state: 'available' }
  /**
   * Spent; capacity returns at `at`, on this window.
   *
   * `in_ms` is that instant minus the `now` this standing was projected against,
   * and it is ALWAYS strictly positive — a window whose reset has passed is not
   * "returning", it has rolled. Carrying it makes the sentence "capacity in
   * {countdown}" unable to render "capacity in available now", which is what an
   * "in ‹…›" template does when it is handed a countdown formatter's zero
   * sentinel. It is a duration that lives for the length of one paint and is
   * recomputed on the next; the wire still carries only the instant.
   */
  | { state: 'returns'; at: number; window: 'session' | 'weekly'; in_ms: number }
  /** Cannot be known: no reset instant, or a reading too old to claim room from. */
  | { state: 'unknown' }

/** One window as the card draws it: the reading, plus whether it is a floor. */
export interface ProjectedWindow extends UsageWindow {
  /**
   * True when this fraction is a LOWER BOUND rather than a current reading: the
   * sample is older than its pool's staleness deadline and the window has not
   * reset since it was taken, so consumption can only have climbed. Rendered as
   * "≥ 43%" with the age, which is the locked posture — floor a stale gauge with
   * its age rather than blanking it or extrapolating past it.
   */
  floor: boolean
}

/** One account's standing inside a pool, as of this paint. One card chip each. */
export interface ProjectedAccount {
  account_label: string | null
  measured_at: number
  /** `now − measured_at`. Recomputed every paint; never taken from the wire. */
  age_ms: number
  stale: boolean
  session: ProjectedWindow | null
  weekly: ProjectedWindow | null
  /**
   * Which window decides this account's capacity — the one whose standing is
   * worst. Null when nothing is known. This is the field that stops "the 5-hour
   * window resets in 17m" from being reported as capacity when the 7-day window
   * is the actual constraint.
   */
  binding: 'session' | 'weekly' | null
  capacity: CapacityStanding
}

/** The pool-level headline: "how hard can I push, right now?" */
export interface PoolCapacity {
  available_now: number
  returning: number
  /** Accounts whose standing cannot be known. NEVER counted as available. */
  unknown: number
  next_account_label: string | null
  /** The headline account's standing. The line renders this, and nothing else. */
  next: CapacityStanding
  /** The window that BINDS the headline account, so the line can name it. */
  next_binding: ProjectedWindow | null
  next_other_window: 'session' | 'weekly' | null
  /**
   * The OTHER window on the headline account, so the line can name what still
   * binds: "next capacity in 17m (5h window; 7d window ≥ 98% used)". THE WHOLE
   * WINDOW rather than a bare fraction, because the floor flag travels with it —
   * a headline that printed "98%" exactly while the row beneath it said "≥ 98%"
   * would be two different claims about one number, and the headline's would be
   * the one that is not true.
   */
  next_other: ProjectedWindow | null
}

/** One pool's card, as of this paint. */
export interface ProjectedPool {
  pool: string
  connection: UsagePoolConnection
  /** Age of the pool's newest reading, or null when nothing was ever measured. */
  age_ms: number | null
  accounts: ProjectedAccount[]
  capacity: PoolCapacity
}

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
// THE OVERLOAD IS LOAD-BEARING, not decoration: `null` comes back for exactly one
// reason — a null window in — so a caller holding a window it has already
// null-checked gets a `CapacityStanding` and needs no second check. That is what
// keeps {@link accountCapacity} free of a defensive branch that could never fire.
export function windowCapacity(
  win: UsageWindow,
  window: 'session' | 'weekly',
  now: number,
  stale: boolean,
): CapacityStanding
export function windowCapacity(
  win: UsageWindow | null,
  window: 'session' | 'weekly',
  now: number,
  stale: boolean,
): CapacityStanding | null
export function windowCapacity(
  win: UsageWindow | null,
  window: 'session' | 'weekly',
  now: number,
  stale: boolean,
): CapacityStanding | null {
  if (win === null) return null
  const rolled = win.reset_at !== null && win.reset_at <= now
  const spent = 1 - win.fraction <= SPENT_HEADROOM_FRACTION
  if (stale) {
    if (!rolled && spent && win.reset_at !== null) {
      return { state: 'returns', at: win.reset_at, window, in_ms: win.reset_at - now }
    }
    return { state: 'unknown' }
  }
  if (rolled) return { state: 'available' }
  if (spent) {
    return win.reset_at === null
      ? { state: 'unknown' }
      : { state: 'returns', at: win.reset_at, window, in_ms: win.reset_at - now }
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
  session: UsageWindow | null,
  weekly: UsageWindow | null,
  now: number,
  stale: boolean,
): { binding: 'session' | 'weekly' | null; capacity: CapacityStanding } {
  // Each candidate carries the WINDOW IT CAME FROM, not just its key. An earlier
  // draft looked the window back up by key and had to defend against a null it
  // could not receive — `windowCapacity` returns null for a null window, so a
  // candidate's window is non-null by construction. A defensive branch that cannot
  // fire is untestable, and untestable code reads as protection that has been
  // exercised when it never has.
  const candidates: Array<{
    window: 'session' | 'weekly'
    win: UsageWindow
    standing: CapacityStanding
  }> = []
  if (session !== null) {
    candidates.push({
      window: 'session',
      win: session,
      standing: windowCapacity(session, 'session', now, stale),
    })
  }
  if (weekly !== null) {
    candidates.push({
      window: 'weekly',
      win: weekly,
      standing: windowCapacity(weekly, 'weekly', now, stale),
    })
  }
  if (candidates.length === 0) return { binding: null, capacity: { state: 'unknown' } }
  let worst = candidates[0]!
  for (const c of candidates.slice(1)) {
    const rank = capacityRank(c.standing)
    const worstRank = capacityRank(worst.standing)
    // Equal standings — two available windows, or two resetting at the same
    // instant — are broken by HEADROOM, so `binding` still names the window that
    // is closest to constraining this account. Left to declaration order it would
    // name whichever window happened to be checked first, and the headline would
    // then report the roomier window as the constraint.
    if (rank > worstRank || (rank === worstRank && 1 - c.win.fraction < 1 - worst.win.fraction)) {
      worst = c
    }
  }
  return { binding: worst.window, capacity: worst.standing }
}

/** A stale reading is a floor only while the window it describes is still running.
 *  Once the reset instant has passed the window has rolled and consumption started
 *  again from zero, so "at least this much" stops being true — and claiming it
 *  would overstate usage on exactly the account that just freed up. */
function projectWindow(
  win: UsageWindow | null,
  stale: boolean,
  now: number,
): ProjectedWindow | null {
  if (win === null) return null
  return { ...win, floor: stale && win.reset_at !== null && win.reset_at > now }
}

/** The pool headline: the first account to have capacity, and what still binds it. */
function poolCapacity(accounts: ProjectedAccount[]): PoolCapacity {
  const empty: PoolCapacity = {
    available_now: 0,
    returning: 0,
    unknown: 0,
    next_account_label: null,
    next: { state: 'unknown' },
    next_binding: null,
    next_other_window: null,
    next_other: null,
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
  const other: 'session' | 'weekly' | null =
    best.binding === null ? null : best.binding === 'session' ? 'weekly' : 'session'
  const other_window = other === null ? null : other === 'session' ? best.session : best.weekly
  return {
    available_now,
    returning,
    unknown,
    next_account_label: best.account_label,
    next: best.capacity,
    // BOTH windows are carried by reference rather than looked up again from the
    // label: two unlabelled accounts share `null`, so a lookup by label would name
    // the first one's window while reporting the second one's standing.
    next_binding: best.binding === null ? null : best.binding === 'session' ? best.session : best.weekly,
    next_other_window: other_window === null ? null : other,
    next_other: other_window,
  }
}

/**
 * THE ONE ENTRY POINT the card renders from: a pool as it stands AT `now`.
 *
 * Called on every paint with the render clock, so a payload held across a dead
 * poller ages honestly in front of the owner: the age chip climbs, the gauges
 * pick up their "≥", and the standing falls back to "unknown" instead of insisting
 * on the availability it had when the response was built.
 */
export function projectPool(pool: UsagePool, now: number): ProjectedPool {
  const accounts: ProjectedAccount[] = pool.accounts.map((account) => {
    const age_ms = now - account.measured_at
    const stale = age_ms > pool.stale_after_ms
    const { binding, capacity } = accountCapacity(account.session, account.weekly, now, stale)
    return {
      account_label: account.account_label,
      measured_at: account.measured_at,
      age_ms,
      stale,
      session: projectWindow(account.session, stale, now),
      weekly: projectWindow(account.weekly, stale, now),
      binding,
      capacity,
    }
  })
  return {
    pool: pool.pool,
    connection: pool.connection,
    age_ms: pool.measured_at === null ? null : now - pool.measured_at,
    accounts,
    capacity: poolCapacity(accounts),
  }
}

// ── Formatting ───────────────────────────────────────────────────────────────
// Pure, exported, and tested directly. These carry product decisions, so both
// cards reuse the same RULES verbatim; a twin that renders `pace: null` as
// "0.0×", or an unknown reset as "now", would tell the same owner a different
// thing about the same reading depending on which device he picked up.

/** `0.36` → `"36%"`. Rounded, because a tenth of a percent of a weekly window is
 *  noise the owner cannot act on. */
export function formatPercent(fraction: number): string {
  return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`
}

/**
 * The countdown to capacity: `"17m"`, `"3h 04m"`, `"2d 5h"`.
 *
 * THE TWO SPECIAL VALUES ARE THE POINT and they must never merge:
 *   - `null` → `"unknown"`. Nobody said when this window resets. Rendering that
 *     as "now" is the failure that sends the owner to raise concurrency into a
 *     wall, and rendering it as an em dash hides a fact he asked for by name.
 *   - `<= 0` → `"available now"`. The instant has passed, so the window has
 *     rolled — a fact about the clock, not a guess about the reading.
 *
 * ONE formatter, not two: an earlier version of this card had a plain duration
 * helper that collapsed "unknown" and "already past" into one dash — exactly the
 * distinction this feature turns on.
 *
 * BECAUSE "available now" IS A WHOLE SENTENCE, nothing may interpolate this into
 * an "in ‹…›" template unless the value is known positive. The two callers that
 * say "in …" read `in_ms` off a `returns` standing, which is positive by
 * construction; that is why the standing carries one.
 */
export function formatCountdown(ms: number | null): string {
  if (ms === null) return 'unknown'
  if (ms <= 0) return 'available now'
  // CEIL, not floor, and not round. Flooring reports capacity arriving sooner than
  // it will — 16m59s rendered as "16m" — and every rounding error in this feature
  // must land on the pessimistic side, because the optimistic one is what puts work
  // into a window that has not reopened yet.
  return formatMinutes(Math.ceil(ms / 60_000))
}

/** `17` → `"17m"`, `184` → `"3h 04m"`, `2941` → `"2d 1h"`. Layout only; the
 *  ROUNDING is the caller's decision, because it points opposite ways for a
 *  countdown and for an age. */
function formatMinutes(totalMinutes: number): string {
  if (totalMinutes < 60) return `${totalMinutes}m`
  const totalHours = Math.floor(totalMinutes / 60)
  if (totalHours < 24) {
    const m = totalMinutes % 60
    return `${totalHours}h ${String(m).padStart(2, '0')}m`
  }
  const d = Math.floor(totalHours / 24)
  return `${d}d ${totalHours % 24}h`
}

/**
 * How long until this window is projected to hit 100%, or null when there is no
 * row to draw.
 *
 * NULL TWICE OVER, and both are omissions rather than dashes:
 *   - no projection at all — the COMMON, GOOD case, where the window refills
 *     faster than it drains. A permanent "Caps out in —" trains the eye to hunt
 *     for a warning that is normally absent.
 *   - a projection whose instant has already PASSED. That can only happen to a
 *     stale reading (a live one always projects inside its own window), and the
 *     card is already saying so much louder — floored figure, age chip, capacity
 *     unknown. Printing a dash there would read as a failed computation.
 */
export function formatProjection(exhausts_at: number | null, now: number): string | null {
  if (exhausts_at === null) return null
  const remaining = exhausts_at - now
  if (remaining <= 0) return null
  return formatCountdown(remaining)
}

/**
 * How old a reading is: `"just now"`, `"12m ago"`, `"3h 04m ago"`.
 *
 * Shown on EVERY card, not only stale ones — an age that appears only when
 * something is wrong is an age nobody learns to read.
 *
 * FLOORED, WHERE THE COUNTDOWN CEILS, and the two are not the same decision worn
 * twice. A countdown is a claim about the FUTURE and rounds away from the owner
 * ("capacity is back in at most 17m"). An age is a claim about the PAST and is
 * exact: at 61 seconds the reading is one minute old, and an earlier draft of this
 * reused the countdown's CEIL and printed "2m ago" — a statement that is simply
 * false, and one that skipped "1m ago" entirely so the chip jumped 0 → 2. Rounding
 * direction is not a safety property here: staleness is decided from `age_ms`
 * against the payload's threshold, never from this string.
 */
export function formatAge(ms: number | null): string {
  if (ms === null) return 'never measured'
  if (ms < 60_000) return 'just now'
  return `${formatMinutes(Math.floor(ms / 60_000))} ago`
}

/**
 * What to call a window, from the length the provider actually reported.
 *
 * NOT a hardcoded "5-hour window": window lengths are not a constant across
 * providers and one of them has already changed regime, so a fixed label would
 * eventually name the wrong thing with total confidence.
 *
 * A SUB-HOUR WINDOW IS NAMED IN MINUTES, because rounding one to hours prints
 * "0h window" — a fabricated zero, in a feature whose whole doctrine is that a
 * fabricated zero must be structurally impossible. Kimi's endpoint can report a
 * length in minutes or seconds, so this is reachable rather than theoretical.
 */
export function windowName(key: 'session' | 'weekly', window_ms: number | null): string {
  if (window_ms === null || window_ms <= 0) return key === 'session' ? 'short window' : 'long window'
  if (window_ms < 3_600_000) return `${Math.max(1, Math.round(window_ms / 60_000))}m window`
  const hours = Math.round(window_ms / 3_600_000)
  if (hours < 48) return `${hours}h window`
  return `${Math.round(hours / 24)}d window`
}

/** `1.5` → `"1.5×"`. Null → `"—"`. One decimal: 1.5 vs 1.52 changes no decision. */
export function formatPace(pace: number | null): string {
  return pace === null ? '—' : `${pace.toFixed(1)}×`
}

/**
 * The one-line reading of a pace, or null when there is nothing to say.
 *
 * This is the sentence that makes the number actionable — a bare "1.5×" means
 * nothing without knowing which side of 1 matters. Deliberately says nothing at
 * all when pace is null, rather than "unknown pace", which would draw the eye to
 * an absence the owner cannot fix.
 */
export function paceNote(pace: number | null): string | null {
  if (pace === null) return null
  if (pace > 1) return 'burning faster than it refills'
  return 'within the refill rate'
}

/** The account this reading belongs to, as the card should say it. NEVER guesses. */
export function accountName(label: string | null): string {
  return label ?? 'active credential'
}

/**
 * What to call a pool on the card.
 *
 * Kimi carries its scope in its own title because its endpoint reports the
 * ACCOUNT, not the key: two keys on one subscription return the same numbers, so
 * a card that implied per-key attribution would be claiming a resolution the
 * provider does not offer. An unknown pool id renders as itself rather than as a
 * blank — a provider added server-side should appear, not disappear.
 */
export function poolTitle(pool: string): string {
  if (pool === 'anthropic') return 'Anthropic'
  if (pool === 'kimi') return 'Kimi (account-wide)'
  if (pool === 'codex') return 'Codex'
  return pool
}

/**
 * A window's utilisation, floored when that is all it is.
 *
 * "≥ 43%" is the locked posture for a stale gauge: show the last known value with
 * its age rather than blanking it, and never present it as current.
 */
export function formatWindowFraction(win: ProjectedWindow): string {
  return win.floor ? `≥ ${formatPercent(win.fraction)}` : formatPercent(win.fraction)
}

/** One account's own answer to "can this take work". */
export function accountCapacityNote(account: ProjectedAccount): string {
  const c = account.capacity
  if (c.state === 'available') return 'available now'
  if (c.state === 'returns') return `capacity in ${formatCountdown(c.in_ms)}`
  return 'capacity unknown'
}

/**
 * THE LINE THE OWNER ASKED FOR: "how hard can I push this provider, right now?"
 *
 * Three shapes, and the second one is why this function exists at all:
 *
 *   - `"1 available now"` — someone has room; that is the whole answer.
 *   - `"Next capacity in 17m (5h window; 7d window 64% used)"` — nobody has room,
 *     so the countdown is to the window that actually BINDS the first account to
 *     free up, and the other window is named with its utilisation. A bare "next
 *     capacity in 17m" would be true of the 5-hour window and false about
 *     capacity, because a nearly-spent weekly window means almost nothing comes
 *     back at that reset.
 *   - `"Next capacity unknown"` — never "now", never blank.
 *
 * An unknown account is always counted out loud — in EVERY shape, including the
 * countdown one. A headline that hides one is a headline computed over a subset.
 */
export function capacityLine(pool: ProjectedPool): string | null {
  const c = pool.capacity
  // A pool with no readings has no standing to report, and "next capacity unknown"
  // next to "Not connected." is noise that teaches the eye to skip the line. The
  // card's empty state says the useful thing instead.
  if (pool.accounts.length === 0) return null
  const unknownSuffix = c.unknown > 0 ? ` (${c.unknown} unknown)` : ''
  if (c.available_now > 0) return `${c.available_now} available now${unknownSuffix}`
  if (c.next.state === 'returns') {
    const parts = [windowName(c.next.window, c.next_binding?.window_ms ?? null)]
    if (c.next_other_window !== null && c.next_other !== null) {
      // The OTHER window's figure carries its own "≥" when it is floored: the
      // headline and the row beneath it are one number and must read as one claim.
      parts.push(
        `${windowName(c.next_other_window, c.next_other.window_ms)} ${formatWindowFraction(
          c.next_other,
        )} used`,
      )
    }
    return `Next capacity in ${formatCountdown(c.next.in_ms)} (${parts.join(
      '; ',
    )})${unknownSuffix}`
  }
  return `Next capacity unknown${unknownSuffix}`
}

/**
 * WHICH account the headline is about — the second half of "how hard can I push".
 *
 * `capacityLine` says WHEN capacity is there; on a pool with more than one account
 * the owner still has to know WHOSE, because that is the account he routes to.
 * This is the render of `next_account_label`, and it is a separate string rather
 * than a clause inside the headline so the headline stays the one short sentence
 * that has to be readable without scrolling.
 *
 * NULL IN TWO CASES, both of them "this would add no information":
 *   - a single-account pool, where the headline is already about the only account;
 *   - an unlabelled winner, where the honest name is "active credential" — naming
 *     it would read as a second account rather than as the one already on screen.
 *
 * It NEVER invents a name; the label is whatever the reading was stamped with, and
 * an unnamed account stays unnamed.
 */
export function nextAccountNote(pool: ProjectedPool): string | null {
  if (pool.accounts.length < 2) return null
  const label = pool.capacity.next_account_label
  if (label === null) return null
  return `Next up: ${label}`
}

/**
 * Why a pool has nothing to show, in the owner's terms. Null when it has
 * readings, because a card with numbers on it needs no excuse.
 *
 * Three different fixes hide behind one empty card, so they get three sentences:
 * connect an account, wait for the first reading, or nothing at all — a per-token
 * API key has no window to meter and never will.
 */
export function connectionNote(pool: ProjectedPool): string | null {
  if (pool.accounts.length > 0) return null
  if (pool.connection === 'not_connected') return 'Not connected.'
  if (pool.connection === 'no_meter') {
    return 'Connected, but this credential is billed per token and has no window to meter.'
  }
  return 'No readings yet.'
}
