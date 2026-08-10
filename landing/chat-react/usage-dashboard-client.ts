/**
 * landing/chat-react — the usage-dashboard client.
 *
 *   GET /api/app/usage/dashboard → { pools: [ { session, weekly, … } ] }
 *
 * The meter in the divider answers "how full is the window". This answers the
 * question a single reading cannot: **is it going to run out before it resets,
 * and when.** That comes off the persisted series, so everything here is a read
 * of history the server has already summarised — this file does no arithmetic on
 * quota, only formatting.
 *
 * ── NULL IS AN ANSWER, NOT A ZERO ────────────────────────────────────────────
 * Three fields are legitimately null and each means something different:
 *
 *   - `pace: null` — refusing to answer. Either the reset time is unknown or the
 *     window has barely started, where dividing by a near-zero elapsed fraction
 *     produces a number in the hundreds that is arithmetically correct and
 *     completely misleading. Renders as an em dash. NEVER as 0, which would read
 *     as "you are using nothing".
 *   - `exhausts_at: null` — the COMMON, GOOD case: at this pace the window
 *     refills faster than it drains, so there is nothing to project. The line is
 *     omitted entirely rather than shown empty, because an empty "caps at" row
 *     reads as a failure to compute.
 *   - `account_label: null` — nothing on this box can name which account the
 *     reading belongs to, because the credential is swapped by a process outside
 *     it. Renders as "active credential". It must NEVER guess a name.
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
  reset_at: number | null
  resets_in_ms: number | null
  pace: number | null
  exhausts_at: number | null
}

export interface UsagePool {
  pool: string
  measured_at: number | null
  account_label: string | null
  session: UsageWindow | null
  weekly: UsageWindow | null
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
    reset_at: numOrNull(rec['reset_at']),
    resets_in_ms: numOrNull(rec['resets_in_ms']),
    pace: numOrNull(rec['pace']),
    exhausts_at: numOrNull(rec['exhausts_at']),
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
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
    const label = rec['account_label']
    decoded.push({
      pool,
      measured_at: numOrNull(rec['measured_at']),
      account_label: typeof label === 'string' && label.length > 0 ? label : null,
      session: decodeWindow(rec['session']),
      weekly: decodeWindow(rec['weekly']),
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
// so when the phone card lands it must reuse these RULES verbatim; a twin that
// renders `pace: null` as "0.0×" would tell the same owner a different thing
// about the same reading.

/** `0.36` → `"36%"`. Rounded, because a tenth of a percent of a weekly window is
 *  noise the owner cannot act on. */
export function formatPercent(fraction: number): string {
  return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`
}

/**
 * `9_000_000` → `"2h 30m"`. Null or non-positive → `"—"`.
 *
 * A window whose reset is already in the past is NOT rendered as a negative
 * duration or as "0m": the reading is simply stale, and the honest output is the
 * same dash used for "unknown".
 */
export function formatDuration(ms: number | null): string {
  if (ms === null || ms <= 0) return '—'
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/**
 * `1.5` → `"1.5×"`. Null → `"—"`.
 *
 * One decimal: the difference between 1.5 and 1.52 changes no decision, and a
 * long float in a settings card reads as instrument noise.
 */
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
