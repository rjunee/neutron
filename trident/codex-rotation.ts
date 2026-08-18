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

/** Why a slot is not currently eligible. */
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
  let best: Cooldown | null = null
  for (const w of outcome.snapshot.windows) {
    if (!Number.isFinite(w.used_percent)) continue
    if (w.used_percent < coolPercentFor(w.window_minutes)) continue
    const short = isShortWindow(w.window_minutes)
    // The window's own length is the fallback: right for both regimes, and right
    // for a regime nobody has seen yet.
    const fallbackMs = Number.isFinite(w.window_minutes) && w.window_minutes > 0
      ? w.window_minutes * 60_000
      : short
        ? FAILURE_SHORT_COOLDOWN_MS
        : FAILURE_LONG_COOLDOWN_MS
    const until = w.resets_at_ms !== null ? w.resets_at_ms : now + fallbackMs
    const reason: CoolingReason = short ? 'short-window' : 'long-window'
    if (best === null || until > best.cooling_until) best = { cooling_until: until, cooling_reason: reason }
  }
  return best
}

/**
 * Convert the CLI's `resets_at` (epoch SECONDS) to milliseconds, rejecting a
 * value that cannot be a real reset. Returning null rather than a bogus number
 * makes the caller fall back to the window length, which is always safe.
 */
export function normalizeResetsAt(raw: unknown, now: number): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null
  const ms = raw * 1000
  if (ms <= now) return null
  if (ms > now + MAX_RESET_HORIZON_MS) return null
  return ms
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
      const mins = rec['window_minutes']
      if (typeof used !== 'number' || !Number.isFinite(used)) continue
      windows.push({
        used_percent: used,
        window_minutes: typeof mins === 'number' && Number.isFinite(mins) ? mins : 0,
        resets_at_ms: normalizeResetsAt(rec['resets_at'], now),
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

/** Depth-first search for a `rate_limits` object anywhere in a decoded event. */
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
  if (rl !== null && typeof rl === 'object' && !Array.isArray(rl)) return rl as Record<string, unknown>
  for (const value of Object.values(rec)) {
    const hit = findRateLimits(value)
    if (hit !== null) return hit
  }
  return null
}

/**
 * The stderr fragments that mean "this seat is out of quota", measured rather
 * than guessed: each was recovered from the literals inside the shipped codex
 * binary (codex-cli 0.147.0), verified with a positive control proving the same
 * search DOES return strings from that binary — a search that can only come back
 * empty is not evidence of absence.
 *
 * The single-quote character is deliberately NOT part of any pattern. The binary
 * carries the plain ASCII form, terminals and logs have been seen to carry the
 * curly typographic one, and a classifier that hinged on which of the two
 * arrived would fail OPEN — silently declining to cool a capped seat, which is
 * the failure mode that makes the whole policy inert.
 */
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /hit your usage limit/i,
  /reached your usage limit/i,
  /usage limit reached/i,
  /rate limit reached/i,
  /too many requests/i,
  /quota exceeded/i,
  /workspace credit limit/i,
  /\b429\b/,
]

/** The long-window (weekly) variants, which must cool for a week, not hours. */
const LONG_LIMIT_PATTERNS: readonly RegExp[] = [/hit your weekly limit/i, /weekly limit/i]

/** The short-window (session) variants. */
const SHORT_LIMIT_PATTERNS: readonly RegExp[] = [/hit your session limit/i, /session limit/i]

/**
 * A revoked refresh token, verbatim from the binary and from production logs.
 * This is the #573 signature, and it is the one failure that must NOT be
 * treated as a quota problem: waiting does not fix it.
 */
const UNAUTHORIZED_PATTERNS: readonly RegExp[] = [
  /refresh token was revoked/i,
  /invalid_grant/i,
  /please log out and sign in again/i,
]

/**
 * Classify a failed codex invocation's stderr into a cooldown, or null.
 *
 * NULL IS THE DEFAULT AND THE SAFE ANSWER. Timeouts, 5xx, network resets,
 * content-policy refusals and every unrecognised message return null, because
 * none of them is evidence about quota and cooling on them would retire healthy
 * seats every time the network hiccupped. Only a pattern measured above cools
 * anything; an unfamiliar failure leaves the pool exactly as it was.
 */
export function classifyCodexFailure(stderr: string, now: number): Cooldown | null {
  if (typeof stderr !== 'string' || stderr.length === 0) return null
  for (const re of UNAUTHORIZED_PATTERNS) {
    if (re.test(stderr)) return { cooling_until: now, cooling_reason: 'unauthorized' }
  }
  const rateLimited = RATE_LIMIT_PATTERNS.some((re) => re.test(stderr))
  const longHit = LONG_LIMIT_PATTERNS.some((re) => re.test(stderr))
  const shortHit = SHORT_LIMIT_PATTERNS.some((re) => re.test(stderr))
  if (!rateLimited && !longHit && !shortHit) return null
  if (longHit) return { cooling_until: now + FAILURE_LONG_COOLDOWN_MS, cooling_reason: 'long-window' }
  if (shortHit) return { cooling_until: now + FAILURE_SHORT_COOLDOWN_MS, cooling_reason: 'short-window' }
  return { cooling_until: now + FAILURE_SHORT_COOLDOWN_MS, cooling_reason: 'rate-limited' }
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
