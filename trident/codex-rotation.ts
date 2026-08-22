/**
 * @neutronai/trident — Codex multi-account rotation POLICY (pure).
 *
 * The owner may connect more than one ChatGPT subscription seat. Each seat is a
 * labelled SLOT with its own materialized `CODEX_HOME` directory, and trident
 * picks one per run at the existing `resolve_codex_home` seam
 * (`codex-credential.ts:resolveActiveCodexHome`). This module is the decision
 * layer only — no I/O, no clock, no network — so every rule below is testable
 * against a literal instead of against a live subscription.
 *
 * WHY A DIRECTORY PER ACCOUNT AND NOT A FILE SWAP. The codex CLI rewrites
 * `auth.json` when it refreshes, and a refresh ROTATES the refresh token: two
 * live copies of one account mutually revoke, whichever refreshed later winning.
 * That was observed in production, not theorised. So a seat's bundle lives in
 * exactly ONE directory for its whole life, selection is a POINTER at which
 * directory to hand the run, and a stored bundle is never copied over a file the
 * CLI has since refreshed. Anything that copies a bundle re-creates the bug.
 *
 * WHY THE THRESHOLD IS KEYED ON `window_minutes` AND NOT ON THE FIELD NAME.
 * The CLI reports usage as `rate_limits.primary` / `rate_limits.secondary`, and
 * it is tempting to read those as "the 5-hour window" and "the weekly window".
 * They are not: measured against 12,582 real `token_count` samples drawn from
 * 600 rollout files (codex-cli 0.147.0), `primary.window_minutes` was 10080 — a
 * WEEK — in every single sample, and `secondary` was null in every single
 * sample. A policy that trusted the slot name would have applied the short-window
 * threshold and the short-window fallback duration to a weekly limit, and
 * rotated an account back into service while it was still capped. The window's
 * own declared LENGTH is the only field here that demonstrably carries what its
 * name claims, so the length picks the threshold and the length supplies the
 * fallback duration. That also survives the regime change already on record
 * (a 300-minute window became a 10080-minute one) without a code edit.
 */

/**
 * A window at or under this many minutes is treated as the SHORT (session-class)
 * limit; anything longer is the LONG (weekly-class) limit. A day is the split
 * because every observed short window has been hours (300 minutes) and every
 * observed long one has been a week (10080) — nothing has ever landed between.
 */
export const SHORT_WINDOW_MAX_MINUTES = 1440

/**
 * Cool a short window at 98% and a long window at 99%, mirroring the thresholds
 * the Anthropic rotator has been driven at in anger rather than inventing new
 * ones. The long window is stingier deliberately: a weekly cap costs a week, so
 * the last 1% is worth spending, whereas a session cap costs hours.
 */
export const SHORT_WINDOW_COOL_PERCENT = 98
export const LONG_WINDOW_COOL_PERCENT = 99

/** Fallback cooldowns for a classified FAILURE, which carries no usable window. */
export const FAILURE_SHORT_COOLDOWN_MS = 5 * 60 * 60 * 1000
export const FAILURE_LONG_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Sanity bounds for a `resets_at` after the seconds→milliseconds conversion.
 * A reset must be in the future and not absurdly far into it; the point is to
 * catch the unit bug (a forgotten ×1000 lands the reset in 1970, which would
 * read as "already expired" and un-cool a capped account immediately) rather
 * than to second-guess the server.
 */
export const MAX_RESET_HORIZON_MS = 32 * 24 * 60 * 60 * 1000

/**
 * Ceiling on a cooldown derived from a window's own declared LENGTH.
 *
 * The window length is normally the right fallback, but it is a number the
 * server sends and the shipped CLI declares `daily-limit`, `weekly-limit`,
 * `monthly-limit` AND `annual-limit` windows (measured: those four ids plus
 * `five-hour-limit` are all present as literals in codex-cli 0.147.0, with a
 * positive control proving the same search returns other known strings). An
 * annual window would bench a paid seat for 365 days off one reading, and a
 * corrupt or absurd value multiplies straight through to `Infinity`, which
 * SQLite round-trips as a REAL and no clock comparison can ever clear — a
 * permanent retirement that looks exactly like a working cooldown.
 *
 * Clamping to the same horizon `classifyResetsAt` already enforces on the other
 * input makes the two paths symmetric. The cost of clamping too low is one
 * wasted selection attempt against a still-capped seat, which self-corrects on
 * the next harvest; the cost of not clamping is a seat that never returns.
 */
export const MAX_FALLBACK_COOLDOWN_MS = MAX_RESET_HORIZON_MS

/**
 * Slack added to a cooldown that ends at a server-declared `resets_at`.
 *
 * The reset instant the CLI reports and the instant the server actually refunds
 * the quota are not the same clock, and a cooldown that ends at the reported
 * millisecond makes the seat eligible again at exactly the boundary. Landing a
 * run one tick early spends a whole selection on a seat that answers with the
 * same cap, which then re-cools it — the run is simply lost. A minute of slack
 * costs a minute of a window measured in hours or a week, and removes the class
 * of failure entirely. This is the tolerance the design asked for in place of an
 * equality compare.
 */
export const RESET_JITTER_MS = 60_000

/**
 * Why a slot is not currently eligible.
 *
 * THERE IS NO `rate-limited` REASON, and its absence is deliberate rather than
 * an omission. It would be set by a reactive classifier reading the codex
 * wrappers' stderr — but the wrappers are shell scripts whose stderr is never
 * observed by any TypeScript seam in this repo, so such a classifier would have
 * had no caller and no way to fire. The evidence it was meant to recover —
 * WHICH quota was spent — rides `rate_limit_reached_type` on the CLI's own
 * `token_count` event, which this module already parses, and lands as
 * `short-window` / `long-window`. Declaring a reason no path can set invites the
 * next reader to believe a classifier exists.
 */
// `rate-limited` is main's, and the rebase must not drop it: it is a ROTATION
// decision with its own timer and its own evidence, and a liveness probe knows
// nothing about quota. Absent from this union, `coerceReason` narrows a stored
// 'rate-limited' to 'manual', and the anti-overretract guard then rotates a
// capped seat straight back into service.
export type CoolingReason =
  | 'short-window'
  | 'long-window'
  | 'rate-limited'
  | 'unauthorized'
  | 'manual'

/** One usage window as the CLI reports it, with `resets_at` already in ms. */
export interface RateLimitWindow {
  used_percent: number
  window_minutes: number
  /** Epoch MILLISECONDS, or null when the CLI omitted it or it failed sanity. */
  resets_at_ms: number | null
  /**
   * The window's own `resets_at` is in the PAST, so `used_percent` describes a
   * window that has since rolled over. See `signalToCooldown` — such a window is
   * ignored rather than treated as a reading with no reset attached.
   */
  expired: boolean
}

/** The usage picture harvested from one rollout file. */
export interface CodexUsageSnapshot {
  windows: RateLimitWindow[]
  plan_type: string | null
  /** The CLI's own "which limit did you hit" field; null until a limit is hit. */
  reached_type: string | null
}

/**
 * The result of trying to read a slot's usage.
 *
 * `error` and `absent` are DISTINCT FROM a snapshot showing low usage, and
 * neither may ever cool a slot. A slot that has simply never run has no rollout
 * to read, and a slot whose rollout is unreadable told us nothing — cooling on
 * either would retire a HEALTHY seat on a transient failure and shrink the pool
 * for no reason. The only thing allowed to cool a slot is positive evidence.
 */
export type HarvestOutcome =
  | { kind: 'snapshot'; snapshot: CodexUsageSnapshot }
  | { kind: 'error'; error: string }
  | { kind: 'absent' }

/** Persisted per-slot rotation state. All timestamps epoch MILLISECONDS. */
export interface SlotState {
  slot: string
  /** Round-robin order; ties broken by slot name so selection is deterministic. */
  position: number
  cooling_until: number | null
  cooling_reason: CoolingReason | null
}

/** A cooldown decision: when the slot becomes eligible again, and why it isn't. */
export interface Cooldown {
  cooling_until: number
  cooling_reason: CoolingReason
}

/** Slot ids are slugs: lowercase, digit-or-letter first, dashes inside, ≤32. */
const SLOT_RE = /^[a-z0-9][a-z0-9-]*$/
export const MAX_SLOT_LEN = 32
/** The slot the pre-rotation single credential occupies. Never renamed. */
export const DEFAULT_SLOT = 'default'

/** Normalize + validate a slot id, or null when it is not a legal slug. */
export function normalizeSlot(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().toLowerCase()
  if (trimmed.length === 0 || trimmed.length > MAX_SLOT_LEN) return null
  if (!SLOT_RE.test(trimmed)) return null
  return trimmed
}

/**
 * Is this slot ineligible right now?
 *
 * `unauthorized` IGNORES `cooling_until` AND RETURNS TRUE FOREVER. A revoked
 * refresh token does not heal by waiting — the owner has to paste a fresh
 * bundle — so letting an unauthorized cooldown expire on a timer would rotate
 * the run back onto a seat guaranteed to fail, on a schedule. The state is
 * cleared by reconnecting the slot, which is the only thing that actually fixes
 * it. Encoding that here rather than by writing a far-future timestamp means no
 * caller can accidentally "expire" it by comparing clocks.
 */
export function isCooling(state: SlotState, now: number): boolean {
  if (state.cooling_reason === 'unauthorized') return true
  return state.cooling_until !== null && state.cooling_until > now
}

/** Deterministic round-robin order: by position, then by slot name. */
function ordered(slots: SlotState[]): SlotState[] {
  return [...slots].sort((a, b) =>
    a.position !== b.position ? a.position - b.position : a.slot.localeCompare(b.slot),
  )
}

export interface SelectionResult {
  /** The slot the next run must use. */
  slot: string
  /** Whether this differs from `activeSlot`. */
  rotated: boolean
  /** Every slot is cooling — the returned slot is the incumbent, kept on purpose. */
  exhausted: boolean
}

/**
 * Pick the slot for the next run: the active one if it is eligible, otherwise
 * the next eligible slot in round-robin order after it.
 *
 * WHEN EVERY SLOT IS COOLING, KEEP THE CURRENT ONE — never return null. A
 * capped credential fails with a retryable, legible error; NO credential means
 * the codex seat silently drops out of the review entirely, which is strictly
 * worse and much harder to notice. The `exhausted` flag is how the caller
 * reports that honestly instead of pretending the seat is healthy.
 */
export function selectNextSlot(
  slots: SlotState[],
  activeSlot: string | null,
  now: number,
): SelectionResult | null {
  const ring = ordered(slots)
  if (ring.length === 0) return null

  const activeIdx = ring.findIndex((s) => s.slot === activeSlot)
  const incumbent = activeIdx >= 0 ? ring[activeIdx] : ring[0]
  if (incumbent === undefined) return null

  if (!isCooling(incumbent, now)) {
    return { slot: incumbent.slot, rotated: incumbent.slot !== activeSlot, exhausted: false }
  }

  // Walk the ring from just after the incumbent so repeated exhaustion spreads
  // across seats instead of always re-testing the same next one.
  const start = activeIdx >= 0 ? activeIdx : 0
  for (let step = 1; step <= ring.length; step++) {
    const cand = ring[(start + step) % ring.length]
    if (cand !== undefined && !isCooling(cand, now)) {
      return { slot: cand.slot, rotated: cand.slot !== activeSlot, exhausted: false }
    }
  }
  return { slot: incumbent.slot, rotated: false, exhausted: true }
}

/** Is a window the short (session-class) one, by its own declared length? */
export function isShortWindow(window_minutes: number): boolean {
  return Number.isFinite(window_minutes) && window_minutes > 0 && window_minutes <= SHORT_WINDOW_MAX_MINUTES
}

/** The cool-at percentage for a window, chosen by its LENGTH (see file header). */
export function coolPercentFor(window_minutes: number): number {
  return isShortWindow(window_minutes) ? SHORT_WINDOW_COOL_PERCENT : LONG_WINDOW_COOL_PERCENT
}

/**
 * Turn a harvested usage snapshot into a cooldown, or null for "stays eligible".
 *
 * Every window is considered and the LATEST resulting `cooling_until` wins: if a
 * seat is over both its session and its weekly limit, the weekly one is the real
 * constraint and cooling only until the session reset would rotate it straight
 * back into a wall.
 */
export function signalToCooldown(outcome: HarvestOutcome, now: number): Cooldown | null {
  if (outcome.kind !== 'snapshot') return null

  // THE WHOLE SNAPSHOT IS STALE WHEN EVERY WINDOW IN IT HAS ALREADY RESET, and
  // that verdict has to bind the `reached_type` arm below as well as the
  // percentages. A rollout is a file on disk that the harvest re-reads on every
  // resolve; nothing rewrites it, so a seat that hit its weekly cap eight days
  // ago still has `rate_limit_reached_type: 'weekly-limit'` sitting in its last
  // `token_count` event, alongside the elapsed reset that proves the quota came
  // back. Reading the reached_type without this guard cooled such a seat for a
  // FRESH seven days measured from now — and because a cooling seat is skipped,
  // it never ran, never wrote a newer rollout, and re-cooled itself from the
  // same bytes on the next resolve. A healthy paid seat, benched forever, by a
  // mechanism that looks exactly like a working cooldown.
  const fresh = outcome.snapshot.windows.filter((w) => !w.expired)
  const staleSnapshot = outcome.snapshot.windows.length > 0 && fresh.length === 0
  if (staleSnapshot) return null

  let best: Cooldown | null = null
  for (const w of outcome.snapshot.windows) {
    if (!Number.isFinite(w.used_percent)) continue
    // A WINDOW WHOSE RESET HAS ALREADY PASSED SAYS NOTHING ABOUT NOW. The
    // harvest reads whatever the last run happened to write, and a rollout can
    // be days old — an 8-day-old file reporting 99.6% against a reset that
    // elapsed a week ago describes a window that has since rolled over and a
    // quota that has since been refunded. Cooling on it would bench a healthy,
    // paid-for seat for a fresh full window on the strength of an expired
    // reading, and because the seat is then skipped it may not run again to
    // produce a newer one. Skipping is both correct and self-correcting: the
    // seat stays eligible, runs, and writes a current snapshot.
    if (w.expired) continue
    if (w.used_percent < coolPercentFor(w.window_minutes)) continue
    const short = isShortWindow(w.window_minutes)
    const until = coolUntil(w.resets_at_ms, now + fallbackCooldownMs(w.window_minutes))
    const reason: CoolingReason = short ? 'short-window' : 'long-window'
    if (best === null || until > best.cooling_until) best = { cooling_until: until, cooling_reason: reason }
  }

  // The CLI saying outright that it HIT a limit outranks any percentage. A
  // percentage is a reading taken before the wall; `rate_limit_reached_type` is
  // the wall. It is also the only place the window class survives — the failure
  // text never names it (see `reachedWindowClass`) — so honouring it here is what
  // keeps a weekly cap from being cooled for five hours.
  const hit = reachedWindowClass(outcome.snapshot.reached_type)
  if (hit !== null) {
    // MATCHING THE CLASS IS A PREFERENCE, NOT A PRECONDITION — the class match
    // usually FAILS, which is the difference between using the server's own
    // answer and inventing one. `five-hour-limit` is a short-class hit, but every
    // window the CLI has been observed to report declares 10080 minutes (12,582
    // samples, all weekly), so no window is ever short-class and the match is
    // always undefined. Requiring it meant a five-hour cap fell through to a
    // blind five-hour constant while the same snapshot carried an explicit
    // `resets_at` three hours out: over-cool by two hours, discard the only real
    // datum, and repeat on every harvest because the constant never converges on
    // the reset. ANY fresh window's declared reset beats a constant, because it
    // is the server answering "when" rather than us guessing.
    const matched = fresh.find((w) => isShortWindow(w.window_minutes) === (hit === 'short'))
    const anchor = matched ?? fresh.find((w) => w.resets_at_ms !== null)
    const until = coolUntil(
      anchor?.resets_at_ms ?? null,
      now +
        (matched !== undefined
          ? fallbackCooldownMs(matched.window_minutes)
          : hit === 'short'
            ? FAILURE_SHORT_COOLDOWN_MS
            : FAILURE_LONG_COOLDOWN_MS),
    )
    const reason: CoolingReason = hit === 'short' ? 'short-window' : 'long-window'
    if (best === null || until > best.cooling_until) best = { cooling_until: until, cooling_reason: reason }
  }
  return best
}

/**
 * When a cooldown ends: the declared reset plus tolerance, else a duration.
 *
 * The jitter rides only the RESET path. A duration fallback is already our own
 * conservative number and padding it would compound a guess; a reset is the
 * server's instant, and that is the one worth not landing exactly on.
 */
function coolUntil(resets_at_ms: number | null, fallback: number): number {
  return resets_at_ms !== null ? resets_at_ms + RESET_JITTER_MS : fallback
}

/**
 * How long to cool a window that reported no usable `resets_at`.
 *
 * The window's own length is the natural answer — right for both observed
 * regimes and right for one nobody has seen yet — but it is clamped, because an
 * annual window or a corrupt value would otherwise retire a seat for a year or
 * forever. See `MAX_FALLBACK_COOLDOWN_MS`.
 */
export function fallbackCooldownMs(window_minutes: number): number {
  // A length we cannot read is treated as LONG, matching `coolPercentFor`: the
  // two must agree, or a window could be judged against the weekly threshold and
  // then cooled for a session's worth of time. (The short constant is
  // unreachable from here by construction — `isShortWindow` demands a finite
  // positive number, which is exactly what this guard has already excluded — so
  // it is not offered as a branch that can never be taken.)
  if (!Number.isFinite(window_minutes) || window_minutes <= 0) return FAILURE_LONG_COOLDOWN_MS
  return Math.min(window_minutes * 60_000, MAX_FALLBACK_COOLDOWN_MS)
}

/**
 * The three genuinely different things a `resets_at` can be.
 *
 * Collapsing `expired` into `absent` is the bug this exists to prevent: they
 * point in OPPOSITE directions. `absent` means the CLI told us nothing about
 * when the window ends, so a fallback duration is the safe response. `expired`
 * means the CLI told us the window ended BEFORE NOW, which makes the
 * accompanying `used_percent` a stale reading of a window that has already
 * rolled over — the safe response there is to ignore the sample entirely, not to
 * start a fresh full-length cooldown from it.
 */
export type ResetsAtClass =
  | { kind: 'future'; ms: number }
  | { kind: 'expired' }
  | { kind: 'absent' }

export function classifyResetsAt(raw: unknown, now: number): ResetsAtClass {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return { kind: 'absent' }
  const ms = raw * 1000
  // Still the unit guard: a forgotten ×1000 lands in 1970, which reads as
  // long-expired. That is caught here as `expired`, and an expired window is
  // ignored rather than trusted, so the unit bug cannot un-cool a capped seat.
  if (ms <= now) return { kind: 'expired' }
  if (ms > now + MAX_RESET_HORIZON_MS) return { kind: 'absent' }
  return { kind: 'future', ms }
}

/**
 * Extract the LAST `rate_limits` snapshot from a rollout JSONL body.
 *
 * The last one is the point of the exercise: earlier events in the same session
 * describe usage before that session spent any, so keying off the first snapshot
 * would systematically under-report and never cool anything.
 *
 * Unparseable lines are SKIPPED rather than failing the harvest — a rollout is
 * appended to live and its tail can be a partial line, which is not a reason to
 * discard the complete records before it.
 */
export function parseRolloutRateLimits(jsonlText: string, now: number): HarvestOutcome {
  let found: CodexUsageSnapshot | null = null
  for (const line of jsonlText.split('\n')) {
    if (!line.includes('"rate_limits"')) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const rl = findRateLimits(obj)
    if (rl === null) continue
    const windows: RateLimitWindow[] = []
    for (const key of ['primary', 'secondary']) {
      const w = rl[key]
      if (w === null || typeof w !== 'object' || Array.isArray(w)) continue
      const rec = w as Record<string, unknown>
      const used = rec['used_percent']
      if (typeof used !== 'number' || !Number.isFinite(used)) continue
      const reset = classifyResetsAt(rec['resets_at'], now)
      windows.push({
        used_percent: used,
        window_minutes: readWindowMinutes(rec),
        resets_at_ms: reset.kind === 'future' ? reset.ms : null,
        expired: reset.kind === 'expired',
      })
    }
    const plan = rl['plan_type']
    const reached = rl['rate_limit_reached_type']
    found = {
      windows,
      plan_type: typeof plan === 'string' ? plan : null,
      reached_type: typeof reached === 'string' ? reached : null,
    }
  }
  if (found === null) return { kind: 'absent' }
  return { kind: 'snapshot', snapshot: found }
}

/**
 * The window length, reading BOTH names the CLI ships.
 *
 * `window_minutes` is what every local rollout carries, but the shipped binary
 * also contains `window_duration_mins` (measured on codex-cli 0.147.0: 13
 * occurrences of the first, 2 of the second). A miss defaults to 0, and 0 is
 * classed as a LONG window — so reading only one name and guessing wrong would
 * silently apply the weekly threshold and a week-long fallback to a five-hour
 * limit. Reading both costs one `??` and removes the guess.
 */
function readWindowMinutes(rec: Record<string, unknown>): number {
  for (const key of ['window_minutes', 'window_duration_mins']) {
    const v = rec[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return 0
}

/**
 * The `event_msg` → `token_count` node that owns a `rate_limits` block.
 *
 * The shape is MEASURED, not assumed: a real rollout line decodes to
 * `{type:'event_msg', payload:{type:'token_count', info:…, rate_limits:{…}}}`,
 * so `rate_limits` sits directly on the object whose own `type` is
 * `token_count`. Requiring that co-location is what stops an unrelated
 * `response_item` that merely happens to carry a nested object of the same name
 * from being read as a quota snapshot — a model's own message quoting this
 * schema would otherwise be accepted as evidence and could cool a seat.
 *
 * The search still recurses, so a future wrapper level does not break it; what
 * it will not do is accept a node that never claimed to be a usage event.
 */
function findRateLimits(node: unknown): Record<string, unknown> | null {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findRateLimits(item)
      if (hit !== null) return hit
    }
    return null
  }
  const rec = node as Record<string, unknown>
  const rl = rec['rate_limits']
  if (rec['type'] === TOKEN_COUNT_EVENT && rl !== null && typeof rl === 'object' && !Array.isArray(rl)) {
    return rl as Record<string, unknown>
  }
  for (const value of Object.values(rec)) {
    const hit = findRateLimits(value)
    if (hit !== null) return hit
  }
  return null
}

/** The CLI's own name for the event that carries a usage snapshot. */
const TOKEN_COUNT_EVENT = 'token_count'

/**
 * Which window class the CLI says it actually hit, from `rate_limit_reached_type`.
 *
 * THIS FIELD IS THE CLI'S OWN DISCRIMINATOR AND IT REPLACES A STDERR CLASSIFIER
 * THAT COULD NOT WORK. An earlier revision of this module tried to tell a
 * session cap from a weekly cap by matching the failure text, using the patterns
 * `/weekly limit/i` and `/session limit/i`. Both match NOTHING the shipped CLI
 * can emit: searching the literals inside codex-cli 0.147.0 returns 0 for each,
 * while `usage limit` returns 23 and the positive controls `codex-cli` and
 * `rate_limit_reached_type` return 9 and 17 — so the search works and the two
 * discriminators are simply absent. The binary's real messages interpose the
 * word "usage" ("You've hit your usage limit") and never name the window at all,
 * which means no amount of pattern-fixing recovers the distinction from text.
 *
 * `rate_limit_reached_type` does carry it, rides the same `token_count` event
 * this module already parses, and needs no new seam. The names come from the
 * limit ids the binary declares: `five-hour-limit`, `daily-limit`,
 * `weekly-limit`, `monthly-limit`, `annual-limit`.
 *
 * An unrecognised value returns null and cools NOTHING, because a name we cannot
 * place is not evidence about which quota was spent.
 */
export function reachedWindowClass(reached: string | null): 'short' | 'long' | null {
  if (typeof reached !== 'string') return null
  const v = reached.toLowerCase()
  if (v.includes('week') || v.includes('month') || v.includes('annual') || v.includes('year')) return 'long'
  if (v.includes('secondary')) return 'long'
  if (v.includes('hour') || v.includes('daily') || v.includes('session')) return 'short'
  if (v.includes('primary')) return 'short'
  return null
}

/**
 * Should the on-disk bundle replace the stored one?
 *
 * DISK IS TRUTH. The codex CLI owns `auth.json` once it is written, and every
 * refresh it performs makes the stored copy staler — until the stored copy holds
 * a refresh token the server has already invalidated. Re-encrypting the newer
 * disk bundle back into the store is what stops the self-heal path from one day
 * restoring a dead token over a live one.
 *
 * Comparison is on `last_refresh`, the field the CLI itself stamps. An
 * unparseable or absent timestamp on either side returns false: without a
 * defensible ordering, leaving both copies alone is the conservative move.
 */
export function shouldHarvestBack(diskLastRefresh: unknown, storedLastRefresh: unknown): boolean {
  const disk = parseIsoMs(diskLastRefresh)
  const stored = parseIsoMs(storedLastRefresh)
  if (disk === null || stored === null) return false
  return disk > stored
}

function parseIsoMs(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? null : ms
}
