/**
 * @neutronai/connect — meeting-point local-slug assigner.
 *
 * M2.6 Phase 2 (Neutron Connect). Per
 * docs/plans/m26-ph2-connect-server-brief.md § 2.2-2.3.
 *
 * A joining member is namespaced WITHIN one owner's session by a
 * meeting-point-assigned `local_slug`. The slug MUST satisfy the LOCKED
 * origin-tag grammar (`^[a-z][a-z0-9-]{2,30}$`, no double-hyphen, no trailing
 * hyphen) because every turn the member routes is
 * `stampOriginInstance(payload, local_slug)` — a grammar violation would throw at
 * the stamp boundary (connect/api/origin-tag.ts:55) and break
 * routing. By assigning the slug at the meeting point (rather than trusting the
 * joiner's foreign home id) we guarantee uniqueness within the owner's session
 * and freeze the attribution-slug grammar (the Slack-Connect host-assigns
 * shape, connect-spec §1.5).
 *
 * `assignLocalSlug` derives a candidate from the member's display name, then
 * resolves collisions with the same `-2`, `-3`, ... suffix discipline as
 * `provisioning/allocate-slug.ts:allocateSlug`. A name that cannot be
 * slugified safely (all-symbols, too short, leading-digit-only) falls back to a
 * grammar-valid generated base ("member") — never a grammar violation (brief
 * test #8).
 */

import {
  validateSlugFormat,
  SlugFormatError,
} from './slug-format.ts'

/**
 * Grammar-valid fallback base used when a display name cannot be slugified into
 * a usable base (empty/too-short/leading-digit). Always passes
 * validateSlugFormat as a bare base.
 */
export const FALLBACK_LOCAL_SLUG_BASE = 'member'

/**
 * Cap the derived base so a `-NN..-NNNN` collision suffix always fits inside the
 * 31-char grammar ceiling. 24 + '-' + up to 4 digits = 29 <= 31.
 */
const MAX_BASE_LEN = 24

/**
 * Derive a grammar-shaped base slug from a free-text display name. Returns `''`
 * when the name yields nothing usable (caller substitutes the fallback base).
 * This does NOT consult the reserved list or collision state — `assignLocalSlug`
 * layers those on top via `isAssignable`.
 */
export function slugifyDisplayName(displayName: string): string {
  let s = displayName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-') // non-alphanumeric runs → single hyphen
    .replace(/-+/g, '-') // collapse repeats
    .replace(/^-+|-+$/g, '') // trim leading/trailing hyphens

  // The grammar requires a leading letter. Strip a leading digit run (and any
  // hyphen it leaves behind); if nothing alphabetic remains, signal fallback.
  s = s.replace(/^[0-9]+/, '').replace(/^-+/, '')
  if (!/^[a-z]/.test(s)) return ''

  if (s.length > MAX_BASE_LEN) {
    s = s.slice(0, MAX_BASE_LEN).replace(/-+$/, '')
  }
  // Grammar floor is 3 chars total. A 1-2 char base is unusable on its own;
  // signal fallback rather than emit an invalid slug.
  if (s.length < 3) return ''
  return s
}

/**
 * A candidate is assignable iff it passes the LOCKED slug grammar AND is not
 * already taken at the meeting point. We reuse `validateSlugFormat` so the
 * grammar check stays single-sourced with the rest of the slug system.
 */
function isAssignable(slug: string, isTaken: (slug: string) => boolean): boolean {
  try {
    validateSlugFormat(slug)
  } catch (err) {
    if (err instanceof SlugFormatError) return false
    throw err
  }
  return !isTaken(slug)
}

export class LocalSlugExhaustedError extends Error {
  override readonly name = 'LocalSlugExhaustedError'
}

/**
 * Assign a collision-free, grammar-valid `local_slug` for `displayName`.
 *
 * @param displayName the member's human label ("Mona")
 * @param isTaken     returns true if a `local_slug` is already in use at this
 *                    meeting point (backed by ConnectedMembersStore.hasSlug)
 *
 * Guarantees the returned slug matches `^[a-z][a-z0-9-]{2,30}$` and is
 * unique. Throws `LocalSlugExhaustedError` only in the pathological case
 * where -2..-9999 are all taken.
 */
export function assignLocalSlug(
  displayName: string,
  isTaken: (slug: string) => boolean,
): string {
  let base = slugifyDisplayName(displayName)
  // Fall back when the name yields no usable base, or (defensively) when the
  // derived base does not pass the grammar as a BARE slug.
  if (base === '' || !canBeBase(base)) {
    base = FALLBACK_LOCAL_SLUG_BASE
  }

  if (isAssignable(base, isTaken)) return base

  for (let i = 2; i <= 9_999; i++) {
    const candidate = `${base}-${i}`
    if (isAssignable(candidate, isTaken)) return candidate
  }
  throw new LocalSlugExhaustedError(
    `could not assign a local_slug for "${displayName}" (base "${base}"): suffixes -2..-9999 all taken`,
  )
}

/** A base is usable directly when it passes the slug grammar. */
function canBeBase(base: string): boolean {
  try {
    validateSlugFormat(base)
    return true
  } catch (err) {
    if (err instanceof SlugFormatError) return false
    throw err
  }
}
