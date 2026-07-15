/**
 * @neutronai/gateway/wiring — credential-pool memoizer.
 *
 * Sprint: cc-substrate-migration-3-sites (2026-05-31) — Codex r1 P1 fix.
 *
 * Why this exists. The shared CC-subprocess substrate (and the older
 * `buildImportSubstrate`) accept a lazy `resolvePool: () => Promise<...>`
 * so a credential written to the per-instance `.env` AFTER composer boot is
 * picked up without a gateway restart. The lazy contract is correct — but
 * the production wiring re-runs `resolveLlmCredentials(...)` directly on
 * every dispatch, and `resolveLlmCredentials` calls `newCredentialPool(...)`
 * which constructs a FRESH pool object every time.
 *
 * Consequence (Codex r1 P1 blocker): `reportFailure(pool, cred.id, 429|402|401)`
 * mutates the cooldown clock on the per-call THROWAWAY pool. The next
 * dispatch builds another fresh pool with no memory of the prior failure
 * and `selectCredential` happily re-serves the same credential — straight
 * back into the same rate-limit window. Cooldown reporting was wired but
 * functionally inert.
 *
 * Fix shape (Path A from the brief). Wrap the per-dispatch resolver with a
 * memoizer keyed on the per-instance `.env` file mtime. The first call runs
 * the resolver and caches the pool. Subsequent calls stat `.env` — if mtime
 * matches the cached value, we return the SAME pool object so cooldown
 * mutations from `reportFailure` survive across calls; if mtime advanced
 * (synthetic-auth wrote a new credential, operator hand-edited `.env`, etc.)
 * we re-resolve and replace the cached pool.
 *
 * Two invalidation triggers. The cached pool is dropped + re-resolved when
 * EITHER:
 *
 *   (a) the per-instance `.env` mtime advances (synthetic-auth wrote a token,
 *       operator hand-edited `.env`, etc.), OR
 *   (b) every credential in the cached pool is in cooldown — i.e.
 *       `hasUsableCredential(pool)` is false (ISSUES #75, below).
 *
 * ISSUES #75 — all-cooldown invalidation. The `.env`-mtime key alone left a
 * gap: if an instance boots with a stale BYO `ApiKeyStore` credential and ALL
 * credentials in the cached pool wedge (401 / 402 / consecutive-failure
 * cooldowns), a DB-side recovery (operator adds a fresh key via
 * `ApiKeyStore`, which does NOT touch `.env`) was not observed until the
 * `.env` mtime bumped or the gateway restarted. We now treat an
 * all-cooldown cached pool like a null result: the next dispatch re-runs
 * the full resolver (which re-reads the `ApiKeyStore` + Max OAuth + env
 * layers) so a DB-added credential is picked up without a touch.
 *
 * The all-cooldown probe is a PURE `hasUsableCredential(pool)` check, NOT a
 * `selectCredential(pool)` call — `selectCredential` mutates (`use_count`,
 * `last_used_at`, round-robin cursor), so probing it on every dispatch
 * would corrupt rotation fairness. The probe is an O(creds) array scan with
 * no I/O, so it adds no meaningful latency to the steady-state hot path
 * (the common case returns the cached pool unchanged).
 *
 * Cooldown carry-forward — the subtle half. A freshly-resolved pool always
 * has its cooldown clocks reset (`newCredentialPool` zeroes them). So when
 * the all-cooldown path re-resolves and ADOPTS the fresh pool, it must
 * carry forward the live cooldown / failure state for any credential whose
 * id persisted from the wedged pool. Without this, adopting the fresh pool
 * would reset the still-wedged credential's cooldown and `selectCredential`
 * (fill_first) would immediately re-serve it — reintroducing the exact
 * Codex r1 P1 inert-cooldown bug this module was built to fix. Genuinely
 * NEW credentials (ids absent from the wedged pool, e.g. the operator's
 * just-added key) start fresh and become immediately selectable. If after
 * carry-forward the re-resolved pool STILL has no usable credential (the
 * set didn't actually recover), we keep the wedged cache as-is and surface
 * `null` — no churn, cooldowns intact, next dispatch retries cheaply.
 *
 * Carry-forward keys on (id AND secret AND base_url), NOT id alone (Argus r1
 * BLOCKING). BYO credential ids are `${provider}:${label}`
 * (auth/byo-api-key-fallback.ts) — secret-independent. An operator swapping a
 * billing-dead key for a fresh secret under the same label keeps the id but
 * changes the secret; carrying the stale cooldown by id alone would re-wedge
 * the instance on a working key (the #75 failure class via the same-label
 * path). A secret/base_url mismatch is therefore treated as a materially new
 * credential that starts fresh — see the inline guard below.
 *
 * `use_count` / `last_used_at` are intentionally NOT carried forward across
 * an all-cooldown re-resolve. They reset to zero on the adopted pool, which
 * briefly skews `least_used` / `round_robin` fairness right after recovery.
 * This is self-correcting — the counters re-accumulate within a few
 * dispatches — and not a correctness issue (only carried-forward cooldown
 * state gates selectability), so it is left out for simplicity.
 *
 * Why the remaining edge cases are acceptable:
 *
 *   1. Max OAuth REFRESH is handled separately by the substrate's
 *      `oauthRefresh.loadAccessToken(...)` call which runs on every
 *      dispatch — the cached pool's OAuth secret is replaced at the env-
 *      layering step regardless of memoization, so token expiry / refresh
 *      keeps working transparently.
 *   2. The synthetic-auth provisioning race that motivated the lazy
 *      `resolvePool` in the first place writes the token directly to
 *      `.env`, so mtime invalidation closes that gap by construction.
 *
 * Null caching policy. We do NOT cache `null` results — every call that
 * returned no credentials re-runs the resolver. This means an instance that
 * boots with no creds, then attaches Max OAuth via DB (no `.env` mutation),
 * still picks up the new credential on the next dispatch even though the
 * mtime didn't change. The cost is one extra resolve per dispatch while
 * the instance is unwired — negligible compared to the alternative of
 * permanently surfacing "no credentials" until a restart.
 */

import { statSync } from 'node:fs'
import { join } from 'node:path'
import { emitSystemEvent } from '@neutronai/persistence/index.ts'
import {
  hasUsableCredential,
  soonestCooldownUntil,
  type CredentialPool,
} from '@neutronai/runtime/credential-pool.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

export interface MemoizeCredentialPoolInput {
  /** Instance home dir whose `.env` file is the invalidation trigger. */
  owner_home: string
  /**
   * The underlying resolver — typically a closure over
   * `resolveLlmCredentials({...})` with the env overlay re-read inline.
   * The memoizer takes ownership of caching the result.
   */
  resolve: () => Promise<CredentialPool | null>
}

/**
 * Wrap a `resolvePool` callback with `.env`-mtime-based memoization.
 *
 * Returns a function with the same shape as `resolvePool` so it drops into
 * `buildLlmCallSubstrate({resolvePool, ...})` / `buildImportSubstrate(...)`
 * unchanged. The wrapped function is safe to call concurrently — a
 * resolution in flight is shared between concurrent callers via the
 * `pending` promise so we never double-resolve.
 */
export function memoizeCredentialPoolByEnvMtime(
  input: MemoizeCredentialPoolInput,
): () => Promise<CredentialPool | null> {
  const envPath = join(input.owner_home, '.env')
  let cached: { pool: CredentialPool; mtime_ms: number } | null = null
  let pending: Promise<CredentialPool | null> | null = null
  // O4 rising-edge latch: the all-cooldown wedge path re-resolves on EVERY
  // dispatch while wedged, so a raw emit would spam. This latch fires the
  // degrade journal ONCE per cooldown episode (healthy→all-cooldown edge) and
  // resets when a usable credential returns. VISIBILITY ONLY — never gates the
  // wedge decision itself.
  let all_cooldown_latched = false

  const readMtimeMs = (): number => {
    try {
      return statSync(envPath).mtimeMs
    } catch {
      // File absent / unreadable — use 0 as sentinel. Cache key still
      // works (cached.mtime_ms === 0 ⇒ no invalidation until .env appears
      // and statSync starts returning a real mtime).
      return 0
    }
  }

  return async (): Promise<CredentialPool | null> => {
    const mtime_ms = readMtimeMs()
    const cachedFresh = cached !== null && cached.mtime_ms === mtime_ms

    // Hot path: cache valid by mtime AND still has a usable credential.
    // `hasUsableCredential` is a pure O(creds) scan — no mutation, no I/O.
    if (cachedFresh && hasUsableCredential(cached!.pool)) {
      all_cooldown_latched = false
      return cached!.pool
    }

    // We re-resolve for one of two reasons:
    //   (a) cache stale / absent (mtime changed, or first call), OR
    //   (b) cache fresh by mtime but ALL credentials are in cooldown
    //       (ISSUES #75) — re-resolve to detect a DB-side credential add.
    // `wedgedCached` is non-null only in case (b); it carries the wedged
    // pool whose live cooldown clocks must survive a pool swap.
    const wedgedCached = cachedFresh ? cached : null

    // Concurrent-call coalescing: if a resolve is already in flight,
    // await its result instead of starting a second one. This matters
    // because the chat surface, /research, and email-managed all share
    // the same memoized resolver in production wiring — concurrent
    // dispatches on a fresh boot would otherwise race two resolutions.
    if (pending !== null) {
      return pending
    }
    pending = (async () => {
      const resolved = await input.resolve()
      if (resolved === null) {
        // Don't cache null — a credential that becomes available via a
        // DB write (Max OAuth attach, BYO key add) that doesn't bump
        // .env mtime should still be picked up on the next call.
        cached = null
        return null
      }
      if (wedgedCached !== null) {
        // ISSUES #75 all-cooldown path. Carry forward the live cooldown /
        // failure state for any credential whose id persisted from the
        // wedged pool, so adopting the re-resolved pool to pick up a
        // newly-added credential does NOT reset the still-wedged
        // credential's cooldown (which would re-serve it under fill_first
        // and reintroduce the Codex r1 P1 inert-cooldown bug). Genuinely
        // new credentials (ids absent from the wedged pool) stay fresh and
        // become immediately selectable.
        const now = Date.now()
        const prior = new Map(wedgedCached.pool.credentials.map((c) => [c.id, c]))
        for (const cred of resolved.credentials) {
          const was = prior.get(cred.id)
          // Same-label rotation guard (Argus r1 BLOCKING). BYO credential
          // ids are `${provider}:${label}` (auth/byo-api-key-fallback.ts) —
          // secret-INDEPENDENT. The most common operator recovery gesture is
          // swapping a billing-dead key for a fresh secret under the SAME
          // label, which yields the same id with new secret material. If we
          // carried cooldown by id alone, the stale cooldown would be stamped
          // onto the working secret — re-wedging the instance on a key that is
          // actually fine, the exact #75 failure class via the same-label
          // path. So carry cooldown ONLY when the secret AND base_url are
          // byte-identical; any change means the credential is materially new
          // and must start fresh (no carry → immediately selectable).
          const sameSecret =
            was !== undefined && was.secret === cred.secret && was.base_url === cred.base_url
          if (
            was !== undefined &&
            sameSecret &&
            was.cooldown_until !== undefined &&
            was.cooldown_until > now
          ) {
            cred.cooldown_until = was.cooldown_until
            if (was.cooldown_reason !== undefined) cred.cooldown_reason = was.cooldown_reason
            cred.consecutive_failures = was.consecutive_failures
          }
        }
        // If the re-resolved set still has no usable credential after
        // carry-forward, the credential set didn't actually recover. Keep
        // the wedged cache as-is (no object churn, mtime preserved) and
        // surface the same null selectCredential would produce — the next
        // dispatch retries the cheap re-resolve.
        if (!hasUsableCredential(resolved)) {
          // O4 — VISIBILITY ONLY: journal the all-cooldown degrade on the
          // rising edge only (not every wedged re-resolve). Control flow is
          // unchanged (still returns the wedged pool); emit can never throw.
          if (!all_cooldown_latched) {
            all_cooldown_latched = true
            fireAndForget('memoize-credential-pool.emitSystemEvent', emitSystemEvent({
              event: 'credential_all_cooldown',
              module: 'credentials',
              payload: {
                credential_count: resolved.credentials.length,
                soonest_cooldown_until: soonestCooldownUntil(resolved),
              },
            }))
          }
          return wedgedCached.pool
        }
      }
      all_cooldown_latched = false
      cached = { pool: resolved, mtime_ms }
      return resolved
    })()
    try {
      return await pending
    } finally {
      pending = null
    }
  }
}
