/**
 * @neutronai/gateway/http — Shared auth helpers.
 *
 * `ownerSlugMismatch(actual, expected)` is the canonical timing-safe
 * instance-slug comparison used by every per-instance HTTP surface to
 * cross-check a resolved bearer's `project_slug` against the slug the
 * gateway was opened with.
 *
 * Why timing-safe: a plain `!==` short-circuits on the first byte
 * mismatch, so the wall-clock latency of a 403 response correlates with
 * the length of the shared prefix between the bearer's resolved slug
 * and the gateway's expected slug. A skilled attacker who already holds
 * a HS256 bearer for instance A could feed it into instance B's gateway
 * and time the 403 to learn the prefix of B's slug. Practical
 * exploitability is low (slugs are semi-public and the HS256 resolver
 * at `channels/adapters/app-ws/auth.ts` already rejects bearers whose
 * signed `project_slug` claim doesn't match BEFORE this surface check
 * runs), but closing the asymmetry is the right call for security
 * parity — every surface does the same thing the same way.
 *
 * Returns true on MISMATCH (so call sites read naturally as
 * `if (ownerSlugMismatch(resolved, expected)) return 403`). Length
 * differences are themselves a side-channel — accepted, because slug
 * grammar caps length narrowly and `timingSafeEqual` requires equal
 * buffer lengths.
 */

import { constantTimeEqual } from '@neutronai/runtime/constant-time-equal.ts'

export function ownerSlugMismatch(actual: string, expected: string): boolean {
  return !constantTimeEqual(actual, expected)
}

/**
 * Resolve an instance slug (either the frozen `internal_handle` OR the
 * current renameable `url_slug`) to its canonical `internal_handle`.
 * Returns `null` when the slug matches no instance in the registry.
 */
export type OwnerHandleResolver = (slug: string) => string | null

/**
 * Minimal structural view of the provisioning registry (`OwnersRegistry`)
 * — just the two lookups the canonical instance-identity
 * match needs. Structural so tests can pass the real registry or a stub.
 */
export interface OwnerHandleLookup {
  getByInternalHandle(internal_handle: string): { internal_handle: string } | undefined
  getBySlug(url_slug: string): { internal_handle: string } | undefined
}

/**
 * Build a `OwnerHandleResolver` over the instances registry. Tries the
 * frozen `internal_handle` first (the common case for gateway-bound
 * slugs from `NEUTRON_INSTANCE_SLUG`), then the current `url_slug` (the
 * common case for session-cookie slugs minted from the public
 * subdomain).
 */
export function buildOwnerHandleResolver(registry: OwnerHandleLookup): OwnerHandleResolver {
  return (slug: string): string | null => {
    const row = registry.getByInternalHandle(slug) ?? registry.getBySlug(slug)
    return row?.internal_handle ?? null
  }
}

/**
 * Canonical instance-IDENTITY comparison (2026-06-10 slug-rename P0).
 *
 * `ownerSlugMismatch` above compares raw slug STRINGS — which breaks
 * the moment an instance's `url_slug` is renamed post-onboarding: the
 * session cookie carries the NEW url_slug (e.g. "kairos") while the
 * per-instance gateway stays bound to the frozen `internal_handle`
 * (`NEUTRON_INSTANCE_SLUG=t-33333333`), so every cookie-authed surface
 * 401'd `project_mismatch` and the sidebar rendered General-only.
 *
 * INVARIANT: a url_slug rename must NEVER break cookie-authed HTTP
 * requests. Instance identity is the frozen `internal_handle`; the
 * renameable `url_slug` is presentation. This helper resolves BOTH
 * sides through the instances registry to their `internal_handle` and
 * compares those (timing-safe). A side that resolves to no instance
 * falls back to its raw value so two unknown-but-equal slugs still
 * match (test fixtures, registry-less compositions) and an unknown
 * slug can never equal a known instance's handle.
 *
 * Call sites MUST use this — never a raw `!==` / `ownerSlugMismatch`
 * on a claim's project_slug vs a gateway-bound slug. When `resolve` is
 * undefined (composition without a registry) this degrades to the raw
 * timing-safe compare.
 *
 * Returns true on MISMATCH, mirroring `ownerSlugMismatch`.
 */
export function ownerIdentityMismatch(
  actual: string,
  expected: string,
  resolve?: OwnerHandleResolver,
): boolean {
  const canonActual = (resolve !== undefined ? resolve(actual) : null) ?? actual
  const canonExpected = (resolve !== undefined ? resolve(expected) : null) ?? expected
  return ownerSlugMismatch(canonActual, canonExpected)
}
