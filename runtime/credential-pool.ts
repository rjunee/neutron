/**
 * @neutronai/runtime — credential pool with rotation + cooldown.
 *
 * Port of Hermes' `credential_pool.py` (TIER 1 lift target per
 * internal design notes § 2).
 * Same four selection strategies; cooldown TTLs tightened where the Hermes
 * value was not justified by data and tracked with a per-credential reason
 * tag so observability can attribute pool churn.
 *
 * Used by every substrate adapter that talks to a multi-key upstream:
 *
 *   - `runtime/adapters/claude-code/`        — same-user multi-sub Claude Max OAuth pool
 *                                              (per Atlas's session-id portability research)
 *   - `runtime/adapters/gpt-5-5-codex-cli/`  — Codex CLI device-code OAuth + BYO API key pool
 *   - `runtime/adapters/gpt-5-5-api/`        — OpenAI API key pool (BYO; no subscription path)
 *
 * Adapters call `selectCredential(pool)` to pick a credential, then
 * `reportSuccess(pool, id)` after a 2xx and `reportFailure(pool, id, status,
 * retry_after_ms?)` after 429/402/401 / 5xx so the cooldown clock + failure
 * counter advance.
 *
 * `member_rotation` (pooling Max OAuth tokens between humans) is forbidden per
 * `engineering-plan.md` line 142 + line 237. This pool only mixes credentials
 * within a single billing context (one user's many subs, one workspace's many
 * keys, etc.) — the caller is responsible for never mixing owners.
 */

export type CredentialStrategy = 'fill_first' | 'round_robin' | 'random' | 'least_used'

export type CredentialKind = 'api_key' | 'oauth' | 'codex_oauth'

export type CooldownReason = 'rate_limit_429' | 'billing_402' | 'auth_401' | 'consecutive_failures' | 'manual'

/** Cooldown TTLs. Exported so adapters can override per-call when they have better data. */
export const COOLDOWN_429_MS = 60_000
export const COOLDOWN_402_MS = 30 * 60_000
export const COOLDOWN_401_MS = 5 * 60_000
export const MAX_CONSECUTIVE_FAILURES = 5
const CONSECUTIVE_COOLDOWN_MS = 60 * 60_000

export interface PooledCredential {
  /** Stable identifier (e.g. `anthropic-key-1`). MUST be unique within a pool. */
  id: string
  kind: CredentialKind
  /** Secret material. Never log or include in observability spans. */
  secret: string
  /** Optional override for OpenAI-compatible endpoints. */
  base_url?: string
  added_at: number
  use_count: number
  last_used_at?: number
  /** Epoch-ms; falsy / past = available. */
  cooldown_until?: number
  cooldown_reason?: CooldownReason
  consecutive_failures: number
}

export interface CredentialPool {
  credentials: PooledCredential[]
  strategy: CredentialStrategy
  /** Round-robin cursor — only consumed when `strategy === 'round_robin'`. */
  cursor: number
}

export interface NewPoolInput {
  strategy: CredentialStrategy
  credentials: ReadonlyArray<{
    id: string
    kind: CredentialKind
    secret: string
    base_url?: string
  }>
}

/**
 * Construct a fresh pool. Validates that `id` values are unique — duplicate
 * ids are a configuration bug that would break the failure / success reporters
 * (which look up by id) silently.
 */
export function newCredentialPool(input: NewPoolInput): CredentialPool {
  const seen = new Set<string>()
  const now = Date.now()
  const credentials: PooledCredential[] = input.credentials.map((c) => {
    if (seen.has(c.id)) {
      throw new Error(`newCredentialPool: duplicate credential id ${JSON.stringify(c.id)}`)
    }
    seen.add(c.id)
    const out: PooledCredential = {
      id: c.id,
      kind: c.kind,
      secret: c.secret,
      added_at: now,
      use_count: 0,
      consecutive_failures: 0,
    }
    if (c.base_url !== undefined) out.base_url = c.base_url
    return out
  })
  return { credentials, strategy: input.strategy, cursor: -1 }
}

/**
 * Pure read: `true` when at least one credential is currently selectable
 * (not cooling down). Mirrors the exact `available` predicate
 * `selectCredential` uses below, but does NOT mutate the pool — no
 * `use_count` bump, no `last_used_at` stamp, no round-robin cursor advance.
 *
 * Callers that need a fast "is this pool usable right now?" probe without
 * consuming a selection slot MUST use this rather than `selectCredential`,
 * which would inflate `use_count` and advance the round-robin cursor on
 * every probe (corrupting `least_used` / `round_robin` fairness). The
 * credential-pool memoizer's all-cooldown invalidation check is the first
 * such caller (`gateway/realmode-composer/memoize-credential-pool.ts`).
 */
export function hasUsableCredential(pool: CredentialPool): boolean {
  const now = Date.now()
  return pool.credentials.some((c) => !c.cooldown_until || c.cooldown_until <= now)
}

/**
 * 2026-06-17 (import-analysis-completeness) — soonest wall-clock epoch-ms
 * at which SOME credential in the pool leaves cooldown and becomes
 * selectable again. Returns:
 *   - `null` if at least one credential is already available (nothing to
 *     wait for), OR the pool is empty.
 *   - otherwise the minimum `cooldown_until` across all credentials —
 *     i.e. how long a caller must wait before `selectCredential` can
 *     succeed again.
 *
 * Pure read — does NOT mutate the pool. The import substrate uses this in
 * its all-cooldown branch to tell the runner the ACTUAL retry-after window
 * (so the runner sleeps the right amount + shows an accurate countdown)
 * rather than guessing with a fixed backoff schedule.
 */
export function soonestCooldownUntil(pool: CredentialPool): number | null {
  const now = Date.now()
  let soonest: number | null = null
  for (const c of pool.credentials) {
    // An available credential means nothing to wait for.
    if (!c.cooldown_until || c.cooldown_until <= now) return null
    if (soonest === null || c.cooldown_until < soonest) soonest = c.cooldown_until
  }
  return soonest
}

/**
 * Select the next credential per the pool's strategy, skipping any in
 * cooldown. Mutates the pool: increments `use_count`, sets `last_used_at`,
 * advances the round-robin cursor. Returns `null` if every credential is
 * cooling down — callers MUST treat that as a hard failure (no key to dispatch
 * with) rather than spinning.
 */
export function selectCredential(pool: CredentialPool): PooledCredential | null {
  const now = Date.now()
  const available = pool.credentials.filter((c) => !c.cooldown_until || c.cooldown_until <= now)
  if (available.length === 0) return null

  let pick: PooledCredential
  switch (pool.strategy) {
    case 'fill_first': {
      const first = available[0]
      if (first === undefined) return null
      pick = first
      break
    }
    case 'round_robin': {
      // Advance cursor inside the *available* slice so a credential entering
      // cooldown does not stall rotation. Use the credential id to keep the
      // cursor stable across selections so order is deterministic.
      const ids = available.map((c) => c.id)
      const lastId = pool.credentials[pool.cursor]?.id
      const startIdx = lastId !== undefined ? ids.indexOf(lastId) : -1
      const nextIdx = (startIdx + 1) % ids.length
      const nextId = ids[nextIdx]
      const candidate = pool.credentials.find((c) => c.id === nextId)
      if (candidate === undefined) return null
      pick = candidate
      pool.cursor = pool.credentials.indexOf(pick)
      break
    }
    case 'random': {
      const idx = Math.floor(Math.random() * available.length)
      const candidate = available[idx]
      if (candidate === undefined) return null
      pick = candidate
      break
    }
    case 'least_used': {
      pick = available.reduce<PooledCredential>((acc, c) => {
        if (c.use_count < acc.use_count) return c
        return acc
      }, available[0]!)
      break
    }
  }

  pick.use_count++
  pick.last_used_at = now
  return pick
}

/**
 * Report a non-2xx / connection failure. Sets the cooldown clock per the
 * status code and increments `consecutive_failures`. After
 * `MAX_CONSECUTIVE_FAILURES` strikes the credential is parked for an hour.
 *
 * `retry_after_ms` (parsed from upstream `retry-after` header) overrides the
 * default 429 cooldown — adapters MUST honor it so we play nice with provider
 * back-pressure signals.
 */
export function reportFailure(
  pool: CredentialPool,
  id: string,
  status: number,
  retry_after_ms?: number,
): void {
  const c = pool.credentials.find((x) => x.id === id)
  if (!c) return
  c.consecutive_failures++
  const now = Date.now()
  if (status === 429) {
    c.cooldown_until = now + (retry_after_ms ?? COOLDOWN_429_MS)
    c.cooldown_reason = 'rate_limit_429'
  } else if (status === 402) {
    c.cooldown_until = now + COOLDOWN_402_MS
    c.cooldown_reason = 'billing_402'
  } else if (status === 401) {
    c.cooldown_until = now + COOLDOWN_401_MS
    c.cooldown_reason = 'auth_401'
  }
  if (c.consecutive_failures >= MAX_CONSECUTIVE_FAILURES) {
    c.cooldown_until = now + CONSECUTIVE_COOLDOWN_MS
    c.cooldown_reason = 'consecutive_failures'
  }
}

/**
 * Report a successful dispatch. Resets the failure counter + clears any
 * cooldown so a temporary 429 stops parking the credential after we've
 * confirmed it's working again.
 */
export function reportSuccess(pool: CredentialPool, id: string): void {
  const c = pool.credentials.find((x) => x.id === id)
  if (!c) return
  c.consecutive_failures = 0
  delete c.cooldown_until
  delete c.cooldown_reason
}
