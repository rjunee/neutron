/**
 * Author/origin attribution stamping for cross-instance messages. When a turn
 * crosses an instance boundary into a shared project, it carries an
 * `origin_instance` tag identifying the authoring member (the meeting-point
 * `local_slug`). This is a SPEAKER-ATTRIBUTION stamp — it records WHO authored
 * the turn within the host's one shared session (connect-spec §1.5). It is the
 * seed of the uniform `author` field (connect-spec §4).
 *
 * It is NOT a foreign-content persistence gate. Under the Slack-Connect model a
 * shared project is single-hosted with one memory, so there is no foreign
 * content to gate — a write collaborator's turn IS a write into the host's own
 * memory, attributed to its author. The old foreign-content gate semantics
 * (the symbol-keyed tag + persistence refusal) were ripped with the
 * content-sync mesh (connect-spec §2.1).
 *
 * Wire format: `{ origin_instance: '<slug>', payload: <user-content> }`.
 */

import { validateSlugFormat } from '../slug-format.ts'

export interface TaggedContent<T = unknown> {
  /** Wire field name `origin_instance`. Always populated by stampOriginInstance. */
  origin_instance: string
  /** Opaque payload; the cross-instance API does not introspect. */
  payload: T
}

/**
 * Type guard for `unknown → TaggedContent<unknown>`. Used by the cross-instance
 * API server + channel fan-out to confirm an inbound turn carries its author
 * attribution before routing it into the host session.
 */
export function isTaggedContent(value: unknown): value is TaggedContent<unknown> {
  if (value === null || typeof value !== 'object') return false
  const v = value as { origin_instance?: unknown; payload?: unknown }
  return (
    typeof v.origin_instance === 'string' &&
    v.origin_instance.length > 0 &&
    'payload' in v
  )
}

/**
 * Stamp `payload` with `originSlug` as its authoring member. Re-stamping
 * succeeds (we replace the slug) — that's deliberate so the meeting point can
 * re-attribute a routed turn to the server-resolved member `local_slug`
 * (connect-spec §1.5). The wire field stays `origin_instance`.
 *
 * Throws if `originSlug` does not match the locked `^[a-z][a-z0-9-]{2,30}$`
 * grammar — defense-in-depth so malformed attribution never propagates
 * downstream.
 */
export function stampOriginInstance<T>(payload: T, originSlug: string): TaggedContent<T> {
  validateSlugFormat(originSlug)
  return { origin_instance: originSlug, payload }
}

/**
 * Read the author slug from a tagged value. Returns `null` when missing.
 */
export function getOrigin(value: unknown): string | null {
  if (!isTaggedContent(value)) return null
  return value.origin_instance
}
