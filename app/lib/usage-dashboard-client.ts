/**
 * @neutronai/app — usage-dashboard client (mobile).
 *
 *   GET /api/app/usage/dashboard → { pools: [ { accounts, stale_after_ms, … } ] }
 *
 * THE TWIN of `landing/chat-react/usage-dashboard-client.ts`, kept line-for-line
 * identical below this header except for the client class (the web one takes an
 * `AbortSignal`) — so a reviewer diffing the two files sees drift immediately.
 * Written twice rather than shared, following the convention every client here
 * follows: production code in `app/lib` never imports `landing`, and only the
 * mirror-parity TESTS cross that line.
 *
 * ⚠️ THE BAND AND THE CLAMP ARE NOT TWINNED — they come from
 * `@neutronai/contracts/credential-usage.ts`, which `app` declares and
 * `app/components/UsageMeter.tsx` already imports. Re-declaring a value that IS
 * reachable buys a drift risk for nothing: the phone could have called something
 * amber that the web still drew green.
 *
 * ⚠️ THE PROJECTION AND THE FORMATTERS ARE PRODUCT DECISIONS, NOT TRANSPORT, and
 * they must not diverge. A cross-client parity test in `gateway/__tests__`
 * executes both copies over the same inputs, because a divergence here is the
 * failure nobody reports: each surface stays self-consistent, neither looks
 * broken, and the owner just gets two different answers about their own quota
 * depending on which device they picked up.
 *
 * The meter under the tab bar answers "how full is the window". This answers the
 * two questions a single reading cannot, and they are opposites:
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
 * screen stayed open — a poller dead for six hours would paint as freshly measured
 * with a live countdown running beside it, which is the exact "confident fresh
 * number" the product forbids. Deltas are cheap; a wrong one is not.
 *
 * ── AND THE PAYLOAD IS REFETCHED, BECAUSE AGEING ALONE IS NOT THE ANSWER ─────
 * Computing the deltas at paint fixes the LIE; it does not fix the DATA. A screen
 * that only advanced its clock would walk a perfectly healthy install into
 * staleness: `stale_after_ms` for the Anthropic pool is two and a half minutes
 * (`60_000 × 2 + 30_000` — the constant, not a round number in prose), so a couple
 * of minutes after the screen opened the card would floor its gauges to "≥" and
 * drop its standing to "unknown" while the poller behind it was writing a fresh row
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

/**
 * Why a pool has no readings, when it has none — one value per DIFFERENT FIX.
 *
 * `unreadable` is the one that is not a rounding of the others: the gauge was
 * asked and the answer could not be turned into a reading (key rejected, or a
 * payload shape this build does not understand). It is separate from `connected`
 * precisely because "no readings yet" promises a first reading is coming, and this
 * one is not.
 */
export type UsagePoolConnection = 'connected' | 'not_connected' | 'no_meter' | 'unreadable'

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
 *
 * TIGHTER THAN EVERY DEADLINE THE STORE ACTUALLY SHIPS, which is what "more
 * cautious" has to mean numerically. A previous value of five minutes was 2.5×
 * LOOSER than Anthropic's real deadline, so on a version skew an Anthropic reading
 * up to five minutes old painted fresh and non-floored — the fallback undoing the
 * caution it was written for. One minute is below the tightest real deadline and
 * still twice `USAGE_POLL_MS`, so a healthy install refetches inside it.
 */
export const FALLBACK_STALE_AFTER_MS = 60_000

/**
 * How often a mounted screen REFETCHES the payload.
 *
 * NOT A COSMETIC CADENCE — it is a correctness bound. Every gauge on the card
 * degrades on age: past `stale_after_ms` the fractions become "≥" floors and the
 * account's standing falls to "unknown". If the screen never refetched, that
 * degradation would fire on the CLOCK rather than on anything being wrong, and a
 * healthy install would paint itself broken minutes after the screen opened.
 *
 * So this must stay STRICTLY BELOW the tightest `stale_after_ms` any pool ships
 * (Anthropic's, at two and a half minutes — `persistence/usage-samples-store.ts`),
 * with room for one dropped request. Thirty seconds gives five attempts inside that
 * window
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
  return v === 'not_connected' || v === 'no_meter' || v === 'connected' || v === 'unreadable'
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

export class UsageDashboardClient {
  private readonly base_url: string
  private readonly token: string
  private readonly fetchImpl: FetchImpl

  constructor(opts: UsageDashboardClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  /** Never rejects. Every failure is the same display state. */
  async load(): Promise<UsageDashboard> {
    try {
      const res = await this.fetchImpl(`${this.base_url}${PATH}`, {
        headers: { authorization: `Bearer ${this.token}` },
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
  /**
   * True when this window's reset instant has PASSED as of this paint, so the
   * fraction beside it describes a window that has already rolled. The row still
   * shows it — it is the last thing that was read — but no line that makes a claim
   * about CAPACITY may quote it as the current constraint.
   */
  rolled: boolean
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
  /** Its key, so the line can name the window without inverting the other one. */
  next_binding_window: 'session' | 'weekly' | null
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
 * Is this window spent? COMPARED ON THE FRACTION SIDE, and that is not a stylistic
 * choice — it is the only side on which the boundary lands where the constant says.
 *
 * `1 - fraction <= SPENT_HEADROOM_FRACTION` reads identically and is wrong at
 * exactly one input: `1 - 0.95` is `0.050000000000000044` in binary floating point,
 * so a window at precisely 95% used comes out with MORE than 5% headroom and
 * classifies as available. `fraction >= 1 - SPENT_HEADROOM_FRACTION` computes its
 * threshold once, exactly (`1 - 0.05 === 0.95`), and 0.95 is spent.
 *
 * The direction is the point. The docstring above commits this constant to erring
 * PESSIMISTIC — calling a nearly-spent account spent costs one build routed
 * elsewhere, and the reverse costs a wall — and the subtraction form errs the other
 * way at the boundary the constant is named after.
 */
function windowSpent(fraction: number): boolean {
  return fraction >= 1 - SPENT_HEADROOM_FRACTION
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
// IT TAKES A WINDOW, NEVER A NULL, and that is the smaller half of the rule above
// it: "what does this reading prove" has no answer for a reading that does not
// exist. An earlier version overloaded on `UsageWindow | null` and returned null
// for null — which read as tolerance and was really the door the half-measured
// account walked through. {@link accountCapacity} refuses the pair up front, so
// there is no caller left with a null to pass and no branch here to defend with.
export function windowCapacity(
  win: UsageWindow,
  window: 'session' | 'weekly',
  now: number,
  stale: boolean,
): CapacityStanding {
  const rolled = windowRolled(win, now)
  const spent = windowSpent(win.fraction)
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
 * Has this window's reset instant passed? One definition, used by everything that
 * has to agree about it — the standing, the floor, and the two tie-breaks.
 */
function windowRolled(win: UsageWindow, now: number): boolean {
  return win.reset_at !== null && win.reset_at <= now
}

/**
 * What this window's headroom is worth to a COMPARISON, once the clock is applied.
 *
 * A ROLLED WINDOW COUNTS AS FULLY OPEN, because its stored fraction describes a
 * window that no longer exists. {@link windowCapacity} already treats a rolled
 * window as available; ranking it on the pre-roll number afterwards is the same
 * reading believed twice under two different rules, and it names the window that
 * just freed up as the account's constraint. The symptom is a card that contradicts
 * itself — "1 available now (5h window 99% used)" printed beside a row saying that
 * same window is available now.
 *
 * NOT used for DISPLAY. The row still shows the last figure that was actually read,
 * with its age; this is only what the ordering is allowed to believe.
 */
function comparableHeadroom(win: UsageWindow, now: number): number {
  return windowRolled(win, now) ? 1 : 1 - win.fraction
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
 *
 * ── AND A WINDOW THAT IS ABSENT IS NOT A WINDOW WITH ROOM ───────────────────
 * "The worst of what I can see" is only safe when what is missing is nothing. A
 * null window is not a measured zero — it is the absence of a measurement, and the
 * two are indistinguishable in this shape: `weekly: null` reads identically whether
 * the provider has no weekly limit, the parser dropped the entry, or the sample
 * predates the column. So an account with only ONE of its two windows measured has
 * NO standing, and says so.
 *
 * WHAT THIS PREVENTS, in the failure's own words: a payload carrying a 20% session
 * and no weekly rendered "1 available now" with `unknown: 0`, and a 99%-spent
 * session resetting in 40 minutes rendered the bare countdown "Next capacity in 40m
 * (5h window)" — a sentence about capacity returning, computed without looking at
 * the window that might be the actual constraint. That is the same defect as
 * naming the soonest reset while ignoring the other window, arrived at by the other
 * road: not by mis-ranking two windows, but by ranking one and calling it the pair.
 *
 * THE OTHER WINDOW'S FIGURES STILL RENDER — the row shows "not reported" and the
 * measured window keeps its bar, its pace and its own countdown. Only the CAPACITY
 * CLAIM is withheld, because that is the only output that requires both.
 */
export function accountCapacity(
  session: UsageWindow | null,
  weekly: UsageWindow | null,
  now: number,
  stale: boolean,
): { binding: 'session' | 'weekly' | null; capacity: CapacityStanding } {
  // HALF A READING BUYS NO STANDING. Checked before anything is ranked, so there is
  // no path on which a one-window account reaches the comparison below and wins it.
  if (session === null || weekly === null) return { binding: null, capacity: { state: 'unknown' } }
  // Each candidate carries the WINDOW IT CAME FROM, not just its key, so the
  // tie-break below reads headroom off the same object it ranked. An earlier draft
  // looked the window back up by key and had to defend against a null it could not
  // receive; a defensive branch that cannot fire is untestable, and untestable code
  // reads as protection that has been exercised when it never has.
  const candidates: Array<{
    window: 'session' | 'weekly'
    win: UsageWindow
    standing: CapacityStanding
  }> = [
    {
      window: 'session',
      win: session,
      standing: windowCapacity(session, 'session', now, stale),
    },
    {
      window: 'weekly',
      win: weekly,
      standing: windowCapacity(weekly, 'weekly', now, stale),
    },
  ]
  let worst = candidates[0]!
  for (const c of candidates.slice(1)) {
    const rank = capacityRank(c.standing)
    const worstRank = capacityRank(worst.standing)
    // Equal standings — two available windows, or two resetting at the same
    // instant — are broken by HEADROOM, so `binding` still names the window that
    // is closest to constraining this account. Left to declaration order it would
    // name whichever window happened to be checked first, and the headline would
    // then report the roomier window as the constraint.
    if (
      rank > worstRank ||
      (rank === worstRank && comparableHeadroom(c.win, now) < comparableHeadroom(worst.win, now))
    ) {
      worst = c
    }
  }
  return { binding: worst.window, capacity: worst.standing }
}

/**
 * A stale reading is a floor only while the window it describes is still running.
 * Once the reset instant has passed the window has rolled and consumption started
 * again from zero, so "at least this much" stops being true — and claiming it would
 * overstate usage on exactly the account that just freed up.
 *
 * AND A STALE READING WITH NO RESET INSTANT IS NOT FLOORED EITHER — deliberate, not
 * an oversight in the condition. "≥ 87%" is a claim that the window did not roll,
 * and with no instant nobody knows whether it did: a floor there would be as
 * invented as a fresh number. The doubt is carried by the two marks that ARE
 * warranted — the age chip, and a capacity standing of "unknown" — so the card
 * shows the last known figure with its age and declines to add a bound it cannot
 * support. This is the one place where "floor a stale gauge" yields to "never state
 * something you cannot know", and the direction is safe: the figure is presented as
 * old rather than as current, and nothing downstream reads it as capacity.
 */
function projectWindow(
  win: UsageWindow | null,
  stale: boolean,
  now: number,
): ProjectedWindow | null {
  if (win === null) return null
  const rolled = windowRolled(win, now)
  return { ...win, rolled, floor: stale && win.reset_at !== null && !rolled }
}

/**
 * How much room the account the headline would name actually has, for TIE-BREAKS.
 *
 * Read off the account's BINDING window — the one {@link accountCapacity} already
 * decided is closest to constraining it — so the pool ranks accounts by the same
 * quantity the headline then prints.
 *
 * WITHOUT THIS, EVERY AVAILABLE ACCOUNT TIES. {@link capacityRank} maps every
 * `available` standing to a single sentinel, so a strict comparison keeps
 * `accounts[0]` — and the store returns accounts newest-measurement-first, which
 * is not an ordering by capacity at all. A pool holding one account at 94% used
 * and one at 5% used would headline "2 available now (5h window 94% used)" and
 * point "Next up:" at the spent one purely because it was probed most recently.
 * Latent while an install holds one account per pool; N accounts is the feature.
 *
 * `NEGATIVE_INFINITY` for an account with no binding window, so it never wins a
 * tie: the same posture as `unknown` sorting last in {@link capacityRank}.
 */
function bindingHeadroom(a: ProjectedAccount): number {
  if (a.binding === null) return Number.NEGATIVE_INFINITY
  const win = a.binding === 'session' ? a.session : a.weekly
  if (win === null) return Number.NEGATIVE_INFINITY
  // Already projected against the render clock, so the rolled case is decided —
  // the same rule {@link comparableHeadroom} applies one level down.
  return win.rolled ? 1 : 1 - win.fraction
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
    next_binding_window: null,
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
    const rank = capacityRank(a.capacity)
    const bestRank = capacityRank(best.capacity)
    // MORE headroom wins a tie — the opposite direction to `accountCapacity`'s
    // tie-break, and deliberately so: that one looks for the WORST window inside
    // one account, this one looks for the BEST account inside one pool.
    if (rank < bestRank || (rank === bestRank && bindingHeadroom(a) > bindingHeadroom(best))) {
      best = a
    }
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
    next_binding_window: best.binding,
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
  // A NON-FINITE INPUT IS AN ABSENCE, NOT A DURATION. Every production caller is
  // traced and none can produce one today, but these are EXPORTED policy functions
  // and the failure they would otherwise have is silent and total: `NaN` walks
  // through every comparison below and prints "NaNd NaNh", which is neither a
  // countdown nor an admission that there is none. Folding it into the `null` arm
  // costs one comparison and makes the bad render unreachable rather than merely
  // unreached.
  if (ms === null || !Number.isFinite(ms)) return 'unknown'
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
  // Same guard, same reason as {@link formatCountdown}: a non-finite age is an
  // absent one, and "NaNd NaNh ago" is a chip that looks like a reading.
  if (ms === null || !Number.isFinite(ms)) return 'never measured'
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

/**
 * How a window is named inside a CAPACITY claim: `"5h window 64% used"`, or
 * `"5h window just reset"` when its instant has passed.
 *
 * A ROLLED WINDOW HAS NO CURRENT UTILISATION TO QUOTE. Its fraction was measured
 * against a window that has since ended, so printing it inside the headline states
 * a constraint that stopped existing — and does it beside a row that says the same
 * window is available, so the card contradicts itself in one glance. "Just reset"
 * is the fact the clock actually supports.
 *
 * The ROW is untouched: it keeps showing the last figure read, with its age chip.
 * This is only the rule for sentences that claim something about capacity.
 */
function capacityWindowNote(key: 'session' | 'weekly', win: ProjectedWindow): string {
  const name = windowName(key, win.window_ms)
  return win.rolled ? `${name} just reset` : `${name} ${formatWindowFraction(win)} used`
}

/**
 * One account's own answer to "can this take work".
 *
 * `unknown` NAMES ITS REASON when the reason is a missing window, because the two
 * unknowns have different fixes and only one of them is about age. "Capacity
 * unknown" beside a full-looking card reads as a glitch; "one window not reported"
 * beside a row that already says "not reported" reads as the same fact twice, which
 * is what makes it believable. This is the loud half of the refusal — the quiet
 * half would be a card that simply declines to say anything.
 */
export function accountCapacityNote(account: ProjectedAccount): string {
  const c = account.capacity
  if (c.state === 'available') return 'available now'
  if (c.state === 'returns') return `capacity in ${formatCountdown(c.in_ms)}`
  if (account.session === null || account.weekly === null) {
    return 'capacity unknown — one window not reported'
  }
  return 'capacity unknown'
}

/**
 * THE LINE THE OWNER ASKED FOR: "how hard can I push this provider, right now?"
 *
 * Three shapes, and the second one is why this function exists at all:
 *
 *   - `"1 available now (7d window 90% used)"` — someone has room, AND how much
 *     room, on the window that is closest to taking it away. "Available" is a
 *     boolean and the decision it feeds is not: an account 90% through its weekly
 *     window is available and is still nowhere to send extra concurrency, and a
 *     bare "1 available now" collapses that to the same glance as a fresh account.
 *     The figure is the TIGHTEST window of the account the headline is about, and
 *     it carries its own "≥" when the reading is a floor. Omitted only when no
 *     window is known, which is the case the count already excludes.
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
  if (c.available_now > 0) {
    // HOW MUCH room, not just that there is some — the tightest window of the
    // account the headline names, with its own floor marking.
    const headroom =
      c.next_binding === null || c.next_binding_window === null
        ? ''
        : ` (${capacityWindowNote(c.next_binding_window, c.next_binding)})`
    return `${c.available_now} available now${headroom}${unknownSuffix}`
  }
  if (c.next.state === 'returns') {
    const parts = [windowName(c.next.window, c.next_binding?.window_ms ?? null)]
    if (c.next_other_window !== null && c.next_other !== null) {
      // The OTHER window's figure carries its own "≥" when it is floored: the
      // headline and the row beneath it are one number and must read as one claim.
      parts.push(capacityWindowNote(c.next_other_window, c.next_other))
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
 * Four different fixes hide behind one empty card, so they get four sentences:
 * connect an account, wait for the first reading, fix a gauge that answered with
 * something unreadable, or nothing at all — a per-token API key has no window to
 * meter and never will.
 *
 * THE FOURTH IS THE ONE THAT DOES NOT RESOLVE ITSELF, and it is why this is not a
 * three-way branch. "No readings yet." promises a first reading is coming. When the
 * gauge has been asked and its answer refused — a rejected key, or a payload shape
 * this build does not model — no amount of waiting produces one, and the owner
 * would sit in front of a sentence that is quietly false. So it says what happened
 * and where to look, and still shows no number: a failed gauge read is loud and
 * empty, never a zero.
 *
 * ── AND THE REFUSAL OUTRANKS "IT HAS NUMBERS ON IT" ───────────────────────
 * Which is why `unreadable` is checked BEFORE the "has readings" shortcut, and it is
 * the difference between this refusal being visible and being theoretical. Samples
 * are retained for thirty days (`persistence/usage-samples-store.ts`), so the
 * realistic refusal is not a pool that never read — it is a pool that read fine for
 * a week and then had its key rotated or its schema shift underneath it. Behind an
 * `accounts.length > 0` return, that card keeps its figures, keeps ageing its chips,
 * and says NOTHING about the fact that no reading will ever replace them. The whole
 * point of the state is that the owner learns a refusal is permanent, and a card
 * with stale numbers on it needs that sentence MORE than an empty one does, not
 * less.
 */
export function connectionNote(pool: ProjectedPool): string | null {
  if (pool.connection === 'unreadable') {
    // Two sentences, because the second half differs on whether there is anything
    // on the card to disown. Both say the same thing: nothing newer is coming.
    return pool.accounts.length > 0
      ? "Connected, but the last gauge read didn't produce a reading — check the key, then the logs. The figures below are the last that could be read, and nothing newer is coming until it's fixed."
      : "Connected, but the last gauge read didn't produce a reading — check the key, then the logs. Nothing is shown rather than a zero."
  }
  if (pool.accounts.length > 0) return null
  if (pool.connection === 'not_connected') return 'Not connected.'
  if (pool.connection === 'no_meter') {
    return 'Connected, but this credential is billed per token and has no window to meter.'
  }
  return 'No readings yet.'
}
