/**
 * @neutronai/connect — slug grammar (single source of truth).
 *
 * Lifted from the Managed provisioning module at C1 so the Connect
 * layer (local-slug assignment, origin-tag stamping) validates slugs without
 * importing Managed provisioning code. The grammar is shared by every
 * instance that mints or stamps a slug — Open self-hosters and the Managed
 * fleet alike.
 *
 * Slug grammar — locked.
 *
 *   ^[a-z][a-z0-9-]{2,30}$
 *
 *   - Starts with a letter (no leading digit, no leading hyphen)
 *   - Lowercase letters, digits, and hyphen only
 *   - 3..31 characters total (1 leading letter + 2..30 trailing chars)
 *   - No double-hyphen (rejected via secondary rule below)
 *
 * Constraints come from DNS host-label compatibility +
 * URL-readability + on-disk path safety + reverse-proxy host matching.
 *
 * This module is GRAMMAR-ONLY. It deliberately does NOT consult any
 * reserved-slug list: reserved-slug enforcement is a Managed subdomain
 * concern. The reserved-slug data file ships only with the Managed overlay
 * and is never carved into Open, so a self-hosted Open instance — which has
 * no subdomains and no reserved set, and where a Connect member's
 * `local_slug` is an in-DB attribution handle, never a hostname — used to
 * ENOENT on that file on every collaborator join (the prod defect this rip
 * closes). The Managed allocate + slug-picker gates (`allocateSlug`,
 * `checkSlugAvailability`) layer the reserved check on top of this grammar
 * check via their own loaders.
 */

// Argus PR#438 R2 N5 — SLUG_RE is defined ONCE, in runtime/slug-grammar.ts
// (the Open-classified grammar home); this file re-exports it so the two
// copies that briefly existed across the connect→runtime import edge can
// never drift.
import { SLUG_RE, SYNTHETIC_E2E_SLUG_RE } from '@neutronai/runtime/slug-grammar.ts'

export { SLUG_RE, SYNTHETIC_E2E_SLUG_RE }

export class SlugFormatError extends Error {
  override readonly name = 'SlugFormatError'
  constructor(readonly slug: string, message: string) {
    super(message)
  }
}

/**
 * Grammar check ONLY. Deliberately NOT a namespace-policy gate and NOT a
 * reserved-list gate: this function is reused as a defense-in-depth
 * RE-validator on slugs that already exist (the userid module blocks shell
 * metacharacters before useradd/userdel; origin-tag.ts re-stamps an
 * instance's own slug), so it must accept every slug a live instance can
 * legitimately carry — including the e2e fixture shape `test-<8hex>`. Both
 * the `test-` namespace reservation (ISSUES #217 / Argus PR#438 IMPORTANT 2)
 * and the platform reserved-slug list are allocation POLICY and live on the
 * slug-CLAIMING gates instead:
 *   - provisioning gate: `allocateSlug` in the Managed provisioning module
 *   - `runtime/slug-grammar.ts:checkSlugAvailability` (picker / rename)
 * Putting that policy here broke the e2e harness's own fixture provisioning
 * (Argus PR#438 R2 BLOCKER N1) AND coupled Open to a Managed data file — do
 * not move it back.
 */
export function validateSlugFormat(requested: string): void {
  if (!SLUG_RE.test(requested)) {
    throw new SlugFormatError(
      requested,
      `slug "${requested}" does not match ${SLUG_RE} (3-31 chars, lowercase letter start, [a-z0-9-] only)`,
    )
  }
  if (requested.includes('--')) {
    throw new SlugFormatError(
      requested,
      `slug "${requested}" contains a double-hyphen`,
    )
  }
  if (requested.endsWith('-')) {
    throw new SlugFormatError(
      requested,
      `slug "${requested}" must not end with a hyphen`,
    )
  }
}
