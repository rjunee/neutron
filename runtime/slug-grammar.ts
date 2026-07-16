/**
 * @neutronai/runtime — slug grammar + availability primitive.
 *
 * Pure grammar + structural availability check that ships in Open. The
 * pre-Sprint-B home of these helpers was the provisioning module, which
 * makes them Managed-classified per the Open/Managed split (docs/research/
 * neutron-open-vs-managed-architecture-2026-05-17.md § 2). Sprint B
 * (PlatformAdapter refactor) moves the pure logic up into `runtime/` so
 * Open-classified callers — most importantly `onboarding/interview/
 * engine.ts:computeSlugSuggestionsForPhase` — no longer reach down into
 * the Managed layer.
 *
 * Concrete consumers:
 *   - `runtime/platform-adapter.ts` — defines `SlugAvailabilityProbe`
 *     against the structural interfaces declared here.
 *   - `runtime/platform-adapter-local.ts` — single-instance Open stub,
 *     always returns `{available:true}` because there is no slug
 *     conflict surface on a self-hosted box.
 *   - `runtime/platform-adapter-managed.ts` — Managed adapter, wires the
 *     real `OwnersRegistry` / `SlugHistoryStore` / merged reserved set
 *     into the grammar functions.
 *   - `onboarding/interview/engine.ts` — drives the slug-suggestion
 *     computation off the structural deps below instead of importing
 *     from the provisioning slug-availability module directly.
 *
 * Backwards compatibility: the provisioning `slug-availability.ts`
 * now re-exports the symbols defined here, so any pre-existing import
 * of `checkSlugAvailability` / `sanitizeToSlug` from the provisioning layer
 * continues to work unchanged. Sprint C will physically move the
 * Managed-side adapter; this seam stays the same.
 */

export const SLUG_RE = /^[a-z][a-z0-9-]{2,30}$/

/**
 * Platform-test slug namespace — RESERVED (ISSUES #217 / Argus PR#438
 * IMPORTANT 2). The e2e harness (`scripts/e2e/synthetic-test-instance.sh`)
 * mints throwaway instances shaped `test-<8 hex>`, and the post-deploy
 * stale-fixture teardown WIPES instances in that shape (systemd unit + data
 * dir + POSIX user + registry row). A real instance must therefore never be
 * able to occupy ANY `test-` slug: the whole prefix is reserved, not just
 * the 8-hex shape, so the invariant survives future fixture-shape changes.
 *
 * `SYNTHETIC_E2E_SLUG_RE` is the exact fixture shape the harness mints —
 * the ONLY shape the allocator's explicit e2e bypass may admit.
 */
export const SYNTHETIC_TEST_SLUG_PREFIX = 'test-'
export const SYNTHETIC_E2E_SLUG_RE = /^test-[0-9a-f]{8}$/

/** Is this slug inside the reserved platform-test namespace? */
export function isPlatformTestSlug(slug: string): boolean {
  return slug.startsWith(SYNTHETIC_TEST_SLUG_PREFIX)
}

/**
 * Format-only grammar check that ignores the reserved-slug list. The
 * caller layers reserved / history / registry checks on top via
 * `checkSlugAvailability`.
 */
export function isFormatLegal(slug: string): boolean {
  if (!SLUG_RE.test(slug)) return false
  if (slug.includes('--')) return false
  if (slug.endsWith('-')) return false
  return true
}

export type SlugUnavailableReason =
  | 'invalid_format'
  | 'reserved'
  | 'in_history'
  | 'taken'

export interface SlugAvailability {
  slug: string
  available: boolean
  reason: SlugUnavailableReason | null
}

/**
 * Structural subset of `OwnersRegistry` that `checkSlugAvailability`
 * needs. The Managed `OwnersRegistry` (provisioning layer)
 * satisfies this shape; tests can inject an in-memory stub. The
 * structural typing keeps Open code free of any Managed import.
 */
export interface SlugRegistryProbe {
  getBySlug(url_slug: string): { owner_handle: string } | undefined
}

/**
 * Structural subset of `SlugHistoryStore`. Same rationale as
 * `SlugRegistryProbe` — keeps the import direction one-way (Managed →
 * Open) instead of leaking the Managed concrete type into Open callers.
 */
export interface SlugHistoryProbe {
  isPermanentlyReserved(old_slug: string): boolean
}

export interface CheckSlugAvailabilityInput {
  slug: string
  registry: SlugRegistryProbe
  slugHistory: SlugHistoryProbe
  reservedSlugs: ReadonlySet<string>
  /**
   * Optional self-instance exemption. When the caller is renaming an instance
   * TO its own current slug (CAS-no-op) the registry lookup would
   * otherwise report 'taken'. Pass the renaming instance's owner_handle
   * to allow that case.
   */
  selfOwnerHandle?: string
}

export function checkSlugAvailability(
  input: CheckSlugAvailabilityInput,
): SlugAvailability {
  const slug = input.slug
  if (!isFormatLegal(slug)) {
    return { slug, available: false, reason: 'invalid_format' }
  }
  if (input.reservedSlugs.has(slug)) {
    return { slug, available: false, reason: 'reserved' }
  }
  // Shape-reserved platform-test namespace (not a list entry — see the
  // SYNTHETIC_TEST_SLUG_PREFIX doc above). The picker / rename pre-flight
  // never needs the e2e bypass: fixtures are provisioned via allocateSlug.
  if (isPlatformTestSlug(slug)) {
    return { slug, available: false, reason: 'reserved' }
  }
  if (input.slugHistory.isPermanentlyReserved(slug)) {
    return { slug, available: false, reason: 'in_history' }
  }
  const taken = input.registry.getBySlug(slug)
  if (taken !== undefined) {
    if (
      input.selfOwnerHandle !== undefined &&
      taken.owner_handle === input.selfOwnerHandle
    ) {
      return { slug, available: true, reason: null }
    }
    return { slug, available: false, reason: 'taken' }
  }
  return { slug, available: true, reason: null }
}

/**
 * Sanitize a free-form string (e.g. an agent name) into a candidate
 * url_slug.
 *
 *   - lowercase
 *   - replace any character outside [a-z0-9-] with '-'
 *   - collapse double-hyphens
 *   - strip leading non-letter / leading hyphen / trailing hyphen
 *   - cap at 31 chars
 *
 * Returns null only when sanitization cannot produce a grammar-legal
 * slug (empty input, all digits, too short after stripping).
 */
export function sanitizeToSlug(input: string): string | null {
  if (typeof input !== 'string') return null
  let raw = input.toLowerCase()
  raw = raw.replace(/[^a-z0-9-]/g, '-')
  raw = raw.replace(/-+/g, '-')
  raw = raw.replace(/^[^a-z]+/, '')
  raw = raw.replace(/-+$/, '')
  if (raw.length > 31) raw = raw.slice(0, 31).replace(/-+$/, '')
  if (raw.length < 3) return null
  if (!isFormatLegal(raw)) return null
  return raw
}
