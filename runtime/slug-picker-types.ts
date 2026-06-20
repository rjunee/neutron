/**
 * @neutronai/runtime — Slug-picker outcome + suggestion helper (Sprint B, 2026-05-20).
 *
 * Pure types + a one-line helper for the engine's `slug_chosen` phase.
 * The Managed bridge (`slug-picker-bridge.ts` in the onboarding API layer)
 * adapts the rename orchestrator's call shapes into THIS outcome union,
 * which the engine consumes via the `SlugPickerEngineHook` DI seam.
 *
 * Lifted out of the Managed bridge module so `onboarding/interview/
 * engine.ts` can import the engine-facing surface without taking an
 * import edge on the provisioning layer. The bridge module re-exports
 * the same names so its own callers (chat-bridge slug-picker hook,
 * integration tests) keep working unchanged.
 */

import { sanitizeToSlug, type SlugAvailability } from './slug-grammar.ts'

/**
 * Structural shape of `RenameUrlSlugResult.steps[N]` the engine
 * inspects (the `gateway-refreshed` step's `status` decides whether
 * to keep onboarding state under the OLD slug or to fork). Captured
 * here so the engine does not import the provisioning rename module
 * directly.
 */
export interface RenameUrlSlugStep {
  step: string
  status?: string
}

/**
 * Structural alias for the full rename result the bridge wraps when
 * `outcome.kind === 'renamed'`. The engine only ever reads `steps`;
 * the other fields mirror the Managed `RenameUrlSlugResult` so a
 * literal-form value at test fixtures composes cleanly, and the
 * Managed concrete type structurally satisfies this alias without
 * a cast.
 */
export interface RenameUrlSlugResultShape {
  internal_handle?: string
  old_url_slug?: string
  new_url_slug?: string
  redirect_route_id?: string
  pending_rename_id?: string
  completed_at?: number
  steps: ReadonlyArray<RenameUrlSlugStep>
}

/** All known reject reasons for `RenameError.code`. Structural alias. */
export type RenameErrorCode =
  | 'cas_mismatch'
  | 'taken'
  | 'invalid_format'
  | 'reserved'
  | 'in_history'
  | 'caddy_failed'
  | 'identity_sync_failed'
  | 'telegram_announce_failed'
  | 'gateway_refresh_failed'
  | string

/** Typed outcome returned by the Managed slug-picker bridge. */
export type SlugPickerOutcome =
  | { kind: 'renamed'; result: RenameUrlSlugResultShape; new_slug: string }
  | { kind: 'skipped'; reason: 'user_skipped' | 'same_slug' }
  | { kind: 'rejected'; reason: 'sanitize_failed' }
  | {
      kind: 'rejected'
      reason: 'unavailable'
      availability: SlugAvailability
    }
  | { kind: 'rejected'; reason: 'rename_failed'; code: RenameErrorCode; message: string }

/**
 * Helper: compute the suggested-default slug for the picker UX. The
 * engine passes the user's chosen agent name (e.g. "Nova"); this
 * returns `sanitizeToSlug(agent_name)` so the client can pre-populate
 * the input.
 *
 * Returns null when the agent name is unsuitable as a slug seed (too
 * short, too many non-alphanumeric chars). The client falls back to
 * the current url_slug or asks the user to type freeform.
 */
export function suggestedSlugFromAgentName(
  agent_name: string | null | undefined,
): string | null {
  if (typeof agent_name !== 'string' || agent_name.length === 0) return null
  return sanitizeToSlug(agent_name)
}
