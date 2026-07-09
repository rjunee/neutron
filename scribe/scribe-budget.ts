/**
 * @neutronai/scribe — per-instance budget governor + watchdog constant.
 *
 * LIFTED from Nova's `gateway/scribe-budget.ts` (token bucket + concurrency
 * cap + daily counter + circuit breaker). Adapted for Neutron:
 *
 *   - **Per-instance, not process-wide.** Nova ran one process-wide budget for
 *     a single user. Neutron is multi-instance, so each instance owns its own
 *     `BudgetState` (constructed at composer boot with a per-instance state path
 *     `<owner_home>/.scribe-budget.json`). The mechanism is otherwise lifted
 *     verbatim.
 *   - **Triggers reduced to phase-1 scope.** Phase 1 only fires on the `chat`
 *     trigger. `email` / `calendar` / `meeting` are reserved in the union for
 *     phase 2 (Cores-fed extract sources) but are not wired anywhere yet.
 *   - **Watchdog is an in-process abort, not a pgroup kill.** Nova's scribe
 *     spawned a detached `claude` child and the watchdog SIGKILLed its process
 *     group. Neutron's extract runs in-process through the CC-spawn LLM-call
 *     substrate (`runtime/substrate.ts`), so the watchdog is an `AbortSignal`
 *     timeout (`SCRIBE_WATCHDOG_MS`) the extractor wires to `handle.cancel()`.
 *     The constant lives here so tests can import it.
 *
 * Design notes (carried from Nova):
 *   - Token bucket refills at REFILL_PER_MIN tokens/min, capped at
 *     BUCKET_CAPACITY. The daily count is the hard ceiling.
 *   - Concurrency cap: MAX_INFLIGHT simultaneous extracts. Beyond it is a clean
 *     drop, not a queue — extraction is fire-and-forget; late extraction has
 *     little value vs hot-path protection.
 *   - Circuit breaker: after CB_THRESHOLD consecutive failures the breaker
 *     opens for CB_COOLDOWN_MS; while open all acquires fail fast.
 *   - Daily counter persists to the per-instance state path via atomic
 *     tempfile+rename. Resets on UTC day rollover.
 *
 * Constraints:
 *   - Pure module. No side effects on import.
 *   - All filesystem writes go through writeAtomic to avoid torn reads.
 *   - Every export is a pure function or narrow accessor — no hidden globals.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile, atomicWriteFileSync } from '@neutronai/runtime/atomic-write.ts'

/**
 * Phase 1 fires only on `chat`. Phase 2 adds `calendar` / `email` / `meeting`
 * (Managed Cores' connectors as extract-sources). M2.6 Ph4 adds `syndication`:
 * allowlisted cross-org syndication events persisting into the owner's project-
 * scoped GBrain source. All triggers share ONE per-instance budget governor.
 */
export type ScribeTrigger = 'chat' | 'email' | 'calendar' | 'meeting' | 'syndication'

export const SCRIBE_TRIGGERS: ReadonlyArray<ScribeTrigger> = Object.freeze([
  'chat',
  'email',
  'calendar',
  'meeting',
  'syndication',
])

export const BUCKET_CAPACITY = 10
export const REFILL_PER_MIN = 6
export const MAX_INFLIGHT = 3
export const DAILY_CAP = 500
export const CB_THRESHOLD = 5
export const CB_COOLDOWN_MS = 10 * 60 * 1000

/**
 * In-process watchdog for a single extract dispatch. The extractor starts a
 * timer for this duration and aborts the substrate call (via `handle.cancel()`)
 * if it hasn't completed — then releases the budget slot as a failure. Mirrors
 * Nova's `SCRIBE_WATCHDOG_MS` (300s) but enforced by `AbortSignal`, not a
 * process-group SIGKILL.
 */
export const SCRIBE_WATCHDOG_MS = 300 * 1000

/**
 * Skip extraction on chat turns shorter than this — short conversational
 * messages ("ok", "thanks", "sounds good") carry no entity mentions worth a
 * full LLM extract dispatch. Lifted from Nova's 80-char Telegram threshold.
 */
export const SCRIBE_MIN_CHARS = 80

/**
 * Per-instance state file. Nova used a fixed `entities/.scribe-budget.json`;
 * Neutron keys it under the instance home so each instance's daily counter is
 * isolated.
 */
export function defaultStatePath(ownerHome: string): string {
  return join(ownerHome, '.scribe-budget.json')
}

export type DailyCounts = {
  /** YYYY-MM-DD (UTC). */
  date: string
  total: number
  byTrigger: Record<ScribeTrigger, number>
  rejected: number
  failures: number
}

function emptyByTrigger(): Record<ScribeTrigger, number> {
  return { chat: 0, email: 0, calendar: 0, meeting: 0, syndication: 0 }
}

function emptyCounts(date: string): DailyCounts {
  return { date, total: 0, byTrigger: emptyByTrigger(), rejected: 0, failures: 0 }
}

function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

export type BudgetState = {
  tokens: number
  lastRefillMs: number
  inflight: number
  consecutiveFailures: number
  breakerOpenUntilMs: number
  daily: DailyCounts
  statePath: string
}

/**
 * Construct a fresh per-instance budget state. The in-memory bucket / inflight /
 * breaker intentionally reset on process restart (they are ephemeral); only the
 * persisted daily counter is reloaded so the UTC-day cap survives a restart.
 */
export function createState(statePath: string, now: number = Date.now()): BudgetState {
  const state: BudgetState = {
    tokens: BUCKET_CAPACITY,
    lastRefillMs: now,
    inflight: 0,
    consecutiveFailures: 0,
    breakerOpenUntilMs: 0,
    daily: emptyCounts(utcDate(now)),
    statePath,
  }
  if (existsSync(statePath)) {
    try {
      const raw = readFileSync(statePath, 'utf8')
      const parsed = JSON.parse(raw) as { daily?: Partial<DailyCounts> }
      if (parsed && typeof parsed.daily?.date === 'string' && parsed.daily.date === state.daily.date) {
        state.daily = {
          ...state.daily,
          ...parsed.daily,
          // Merge per-trigger counts defensively so a partial / older on-disk
          // shape can't drop a trigger key the runtime expects.
          byTrigger: { ...emptyByTrigger(), ...(parsed.daily.byTrigger ?? {}) },
        }
      }
    } catch {
      // Corrupt state file — start fresh. Atomic writes keep this rare.
    }
  }
  return state
}

function refill(state: BudgetState, now: number): void {
  const elapsedMs = Math.max(0, now - state.lastRefillMs)
  if (elapsedMs <= 0) return
  const minutes = elapsedMs / 60000
  state.tokens = Math.min(BUCKET_CAPACITY, state.tokens + minutes * REFILL_PER_MIN)
  state.lastRefillMs = now
}

function rolloverDay(state: BudgetState, now: number): void {
  const today = utcDate(now)
  if (state.daily.date !== today) {
    state.daily = emptyCounts(today)
  }
}

export type AcquireResult =
  | { ok: true }
  | { ok: false; reason: 'daily_cap' | 'breaker_open' | 'no_tokens' | 'inflight_cap' }

/**
 * Attempt to reserve one extract slot. Call exactly once before dispatching an
 * extract; on `{ ok: true }` the caller MUST later call `release()` exactly
 * once.
 */
export function tryAcquire(
  state: BudgetState,
  trigger: ScribeTrigger,
  now: number = Date.now(),
): AcquireResult {
  rolloverDay(state, now)

  if (state.breakerOpenUntilMs > now) {
    state.daily.rejected += 1
    return { ok: false, reason: 'breaker_open' }
  }
  if (state.daily.total >= DAILY_CAP) {
    state.daily.rejected += 1
    return { ok: false, reason: 'daily_cap' }
  }
  refill(state, now)
  if (state.tokens < 1) {
    state.daily.rejected += 1
    return { ok: false, reason: 'no_tokens' }
  }
  if (state.inflight >= MAX_INFLIGHT) {
    state.daily.rejected += 1
    return { ok: false, reason: 'inflight_cap' }
  }

  state.tokens -= 1
  state.inflight += 1
  state.daily.total += 1
  state.daily.byTrigger[trigger] += 1
  return { ok: true }
}

/**
 * Release one inflight slot and record success/failure for the circuit
 * breaker. Call exactly once per successful `tryAcquire`, regardless of how the
 * extract resolved (success, error, or watchdog abort — all count as either
 * `ok: true` or `ok: false`).
 */
export function release(state: BudgetState, ok: boolean, now: number = Date.now()): void {
  state.inflight = Math.max(0, state.inflight - 1)
  if (ok) {
    state.consecutiveFailures = 0
    return
  }
  state.consecutiveFailures += 1
  state.daily.failures += 1
  if (state.consecutiveFailures >= CB_THRESHOLD) {
    state.breakerOpenUntilMs = now + CB_COOLDOWN_MS
  }
}

export function snapshot(
  state: BudgetState,
  now: number = Date.now(),
): {
  tokens: number
  inflight: number
  breaker_open: boolean
  breaker_opens_in_ms: number
  daily: DailyCounts
  daily_remaining: number
} {
  rolloverDay(state, now)
  refill(state, now)
  return {
    tokens: Math.floor(state.tokens),
    inflight: state.inflight,
    breaker_open: state.breakerOpenUntilMs > now,
    breaker_opens_in_ms: Math.max(0, state.breakerOpenUntilMs - now),
    daily: { ...state.daily, byTrigger: { ...state.daily.byTrigger } },
    daily_remaining: Math.max(0, DAILY_CAP - state.daily.total),
  }
}

/**
 * Async persist — used on the hot path so the gateway event-loop thread never
 * does synchronous disk I/O. The daily snapshot is captured eagerly (before
 * awaiting) so concurrent budget mutations cannot tear the written document.
 */
export async function persistDaily(state: BudgetState, now: number = Date.now()): Promise<void> {
  rolloverDay(state, now)
  const payload = JSON.stringify(
    { daily: { ...state.daily, byTrigger: { ...state.daily.byTrigger } } },
    null,
    2,
  )
  await atomicWriteFile(state.statePath, payload, { mode: 0o600 })
}

/** Synchronous variant — for tests + startup/shutdown paths where blocking is fine. */
export function persistDailySync(state: BudgetState, now: number = Date.now()): void {
  rolloverDay(state, now)
  atomicWriteFileSync(
    state.statePath,
    JSON.stringify({ daily: { ...state.daily, byTrigger: { ...state.daily.byTrigger } } }, null, 2),
    { mode: 0o600 },
  )
}
