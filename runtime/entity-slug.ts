/**
 * @neutronai/runtime — entity-slug leaf.
 *
 * The ONE source of truth for the entity-slug grammar. Both the entity-writer
 * (which validates a pre-normalised slug) and the slug PRODUCERS (the scribe
 * GBrain writer + the onboarding history-import populator) share this leaf so
 * the grammar can never silently drift between producer and validator.
 *
 * Consolidates the two near-verbatim `slugify` copies flagged by the
 * 2026-06-15 Open refactor audit (P2-8): `scribe/write-to-gbrain.ts` and
 * `onboarding/history-import/entity-populator.ts`. The scribe copy carried a
 * defensive `typeof input !== 'string'` guard; the populator copy did not
 * (its input is statically a string). The shared leaf keeps the guard — a
 * superset that preserves both call sites' behaviour exactly.
 */

/**
 * Entity slug grammar: a lower-case run of `[a-z0-9-]` that starts with an
 * alphanumeric. The single regex `entitySlugify` validates against and the
 * `entity-writer` re-validates a pre-normalised slug against.
 */
export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*$/

/**
 * Lower-case, replace non-alphanumeric runs with hyphens, strip leading/
 * trailing hyphens, cap at 80 chars. Returns `null` when the result doesn't
 * match {@link SLUG_REGEX} (e.g. empty input, or input with no alphanumerics).
 *
 * The 80-char cap guards against a rare LLM-extracted multi-KB "name" blowing
 * up the filesystem; the post-cap trailing-hyphen strip keeps the capped slug
 * grammar-valid.
 */
export function entitySlugify(input: string): string | null {
  if (typeof input !== 'string') return null
  const replaced = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (replaced.length === 0) return null
  if (!SLUG_REGEX.test(replaced)) return null
  return replaced.length > 80 ? replaced.slice(0, 80).replace(/-+$/g, '') : replaced
}
