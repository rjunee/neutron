/**
 * landing/chat-react — the usage-dashboard client.
 *
 *   GET /api/app/usage/dashboard → { pools: [ { accounts, capacity, … } ] }
 *
 * The meter in the divider answers "how full is the window". This answers the two
 * questions a single reading cannot, and they are opposites:
 *
 *   - **is it going to run out before it resets** — pace and the projected cap;
 *   - **when does capacity come back** — the countdown to each window's reset,
 *     and the pool line that reads off it.
 *
 * Both come off the persisted series, so this file does no arithmetic on quota —
 * only formatting. The ONE exception is deliberate and load-bearing: **countdowns
 * are computed here, from the absolute instant the server sent, against this
 * device's clock.** A duration computed on the server is already wrong by the time
 * it renders, and a payload held for an hour would keep saying "17m".
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
 *     which is why the wire shape is a tagged state rather than a nullable number.
 *
 * A rejected fetch resolves to "unreachable", never to an empty series: an older
 * gateway does not mount the route, and a client that drew "0% used" from a 404
 * would be inventing a measurement.
 */

/** One window's standing. Mirrors `@neutronai/persistence/usage-samples-store.ts`,
 *  re-declared rather than imported so the browser bundle keeps no workspace
 *  dependency — the convention every client in this directory follows. */
export interface UsageWindow {
  fraction: number
  /** The window's own length, when the provider reported one. */
  window_ms: number | null
  reset_at: number | null
  resets_in_ms: number | null
  pace: number | null
  exhausts_at: number | null
  /** The fraction is a LOWER BOUND: the reading is stale and its window is live. */
  floor: boolean
}

/** When an account can take work again. A tagged state, never a nullable number. */
export type CapacityStanding =
  | { state: 'available' }
  | { state: 'returns'; at: number; window: 'session' | 'weekly' }
  | { state: 'unknown' }

export interface UsageAccount {
  account_label: string | null
  measured_at: number
  age_ms: number
  stale: boolean
  session: UsageWindow | null
  weekly: UsageWindow | null
  binding: 'session' | 'weekly' | null
  capacity: CapacityStanding
}

export interface PoolCapacity {
  available_now: number
  returning: number
  unknown: number
  next_account_label: string | null
  next: CapacityStanding
  next_other_window: 'session' | 'weekly' | null
  next_other_fraction: number | null
}

/** Why a pool has no readings, when it has none. */
export type UsagePoolConnection = 'connected' | 'not_connected' | 'no_meter'

export interface UsagePool {
  pool: string
  connection: UsagePoolConnection
  measured_at: number | null
  age_ms: number | null
  accounts: UsageAccount[]
  capacity: PoolCapacity
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
    resets_in_ms: numOrNull(rec['resets_in_ms']),
    pace: numOrNull(rec['pace']),
    exhausts_at: numOrNull(rec['exhausts_at']),
    floor: rec['floor'] === true,
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function decodeWindowKey(v: unknown): 'session' | 'weekly' | null {
  return v === 'session' || v === 'weekly' ? v : null
}

/**
 * Decode a capacity standing, defaulting to UNKNOWN.
 *
 * Every unreadable shape lands on `unknown`, never on `available`: an unparseable
 * payload must not become "push more work at it".
 */
function decodeCapacity(raw: unknown): CapacityStanding {
  if (typeof raw !== 'object' || raw === null) return { state: 'unknown' }
  const rec = raw as Record<string, unknown>
  if (rec['state'] === 'available') return { state: 'available' }
  if (rec['state'] === 'returns') {
    const at = numOrNull(rec['at'])
    const window = decodeWindowKey(rec['window'])
    if (at !== null && window !== null) return { state: 'returns', at, window }
  }
  return { state: 'unknown' }
}

function decodeAccount(raw: unknown): UsageAccount | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  const measured_at = numOrNull(rec['measured_at'])
  if (measured_at === null) return null
  const label = rec['account_label']
  return {
    account_label: typeof label === 'string' && label.length > 0 ? label : null,
    measured_at,
    age_ms: numOrNull(rec['age_ms']) ?? 0,
    stale: rec['stale'] === true,
    session: decodeWindow(rec['session']),
    weekly: decodeWindow(rec['weekly']),
    binding: decodeWindowKey(rec['binding']),
    capacity: decodeCapacity(rec['capacity']),
  }
}

const NO_CAPACITY: PoolCapacity = {
  available_now: 0,
  returning: 0,
  unknown: 0,
  next_account_label: null,
  next: { state: 'unknown' },
  next_other_window: null,
  next_other_fraction: null,
}

function decodePoolCapacity(raw: unknown): PoolCapacity {
  if (typeof raw !== 'object' || raw === null) return NO_CAPACITY
  const rec = raw as Record<string, unknown>
  const label = rec['next_account_label']
  return {
    available_now: numOrNull(rec['available_now']) ?? 0,
    returning: numOrNull(rec['returning']) ?? 0,
    unknown: numOrNull(rec['unknown']) ?? 0,
    next_account_label: typeof label === 'string' && label.length > 0 ? label : null,
    next: decodeCapacity(rec['next']),
    next_other_window: decodeWindowKey(rec['next_other_window']),
    next_other_fraction: numOrNull(rec['next_other_fraction']),
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
      age_ms: numOrNull(rec['age_ms']),
      accounts,
      capacity: decodePoolCapacity(rec['capacity']),
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

// ── Formatting ───────────────────────────────────────────────────────────────
// Pure, exported, and tested directly. These carry the product decisions above,
// so the phone card reuses these RULES verbatim; a twin that renders `pace: null`
// as "0.0×", or an unknown reset as "now", would tell the same owner a different
// thing about the same reading.

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
 */
export function formatCountdown(ms: number | null): string {
  if (ms === null) return 'unknown'
  if (ms <= 0) return 'available now'
  // CEIL, not floor, and not round. Flooring reports capacity arriving sooner than
  // it will — 16m59s rendered as "16m" — and every rounding error in this feature
  // must land on the pessimistic side, because the optimistic one is what puts work
  // into a window that has not reopened yet.
  const totalMinutes = Math.ceil(ms / 60_000)
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
 */
export function formatAge(ms: number | null): string {
  if (ms === null) return 'never measured'
  if (ms < 60_000) return 'just now'
  return `${formatCountdown(ms)} ago`
}

/**
 * What to call a window, from the length the provider actually reported.
 *
 * NOT a hardcoded "5-hour window": window lengths are not a constant across
 * providers and one of them has already changed regime, so a fixed label would
 * eventually name the wrong thing with total confidence.
 */
export function windowName(key: 'session' | 'weekly', window_ms: number | null): string {
  if (window_ms === null || window_ms <= 0) return key === 'session' ? 'short window' : 'long window'
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
export function formatWindowFraction(win: UsageWindow): string {
  return win.floor ? `≥ ${formatPercent(win.fraction)}` : formatPercent(win.fraction)
}

/** One account's own answer to "can this take work". */
export function accountCapacityNote(account: UsageAccount, now: number): string {
  const c = account.capacity
  if (c.state === 'available') return 'available now'
  if (c.state === 'returns') return `capacity in ${formatCountdown(c.at - now)}`
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
 * An unknown account is always counted out loud, because a headline that hides
 * one is a headline computed over a subset.
 */
export function capacityLine(pool: UsagePool, now: number): string | null {
  const c = pool.capacity
  // A pool with no readings has no standing to report, and "next capacity unknown"
  // next to "Not connected." is noise that teaches the eye to skip the line. The
  // card's empty state says the useful thing instead.
  if (pool.accounts.length === 0) return null
  const unknownSuffix = c.unknown > 0 ? ` (${c.unknown} unknown)` : ''
  if (c.available_now > 0) return `${c.available_now} available now${unknownSuffix}`
  if (c.next.state === 'returns') {
    const account = pool.accounts.find((a) => a.account_label === c.next_account_label)
    const bindingWindow = c.next.window === 'session' ? account?.session : account?.weekly
    const parts = [windowName(c.next.window, bindingWindow?.window_ms ?? null)]
    if (c.next_other_window !== null && c.next_other_fraction !== null) {
      const otherWindow = c.next_other_window === 'session' ? account?.session : account?.weekly
      parts.push(
        `${windowName(c.next_other_window, otherWindow?.window_ms ?? null)} ${formatPercent(
          c.next_other_fraction,
        )} used`,
      )
    }
    return `Next capacity in ${formatCountdown(c.next.at - now)} (${parts.join('; ')})`
  }
  return `Next capacity unknown${unknownSuffix}`
}

/**
 * Why a pool has nothing to show, in the owner's terms. Null when it has
 * readings, because a card with numbers on it needs no excuse.
 *
 * Three different fixes hide behind one empty card, so they get three sentences:
 * connect an account, wait for the first reading, or nothing at all — a per-token
 * API key has no window to meter and never will.
 */
export function connectionNote(pool: UsagePool): string | null {
  if (pool.accounts.length > 0) return null
  if (pool.connection === 'not_connected') return 'Not connected.'
  if (pool.connection === 'no_meter') {
    return 'Connected, but this credential is billed per token and has no window to meter.'
  }
  return 'No readings yet.'
}
