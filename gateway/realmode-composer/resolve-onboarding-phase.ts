/**
 * @neutronai/gateway/realmode-composer — onboarding-phase lookup helper.
 *
 * Lets the composer decide between mounting the real chat surface vs the
 * Max-OAuth gate page based on BOTH credential presence AND the owner's
 * current onboarding phase.
 *
 * Before this helper, the composer collapsed to the gate page whenever
 * Anthropic credentials were absent — which mis-categorised brand-new
 * owners that were still in `signup` and didn't need an LLM yet. The
 * gate was supposed to surface for returning users with revoked Max
 * tokens (the comment at the gate's call site already says so), not for
 * first-time signups whose first conversation is static persona-discovery.
 *
 * Decision rule:
 *   - phase ∈ POST_MAX_OAUTH_PHASES (max_oauth_offered / wow_fired /
 *     completed) AND no creds → render the gate page.
 *   - any other phase (including `null` for brand-new pre-engine-bootstrap)
 *     → mount the real chat surface. The engine walks its static fallback
 *     for early phases so the absence of an LLM credential is harmless;
 *     by the time the engine reaches `max_oauth_offered` the user has
 *     pasted a token via the in-conversation prompt.
 *
 * `failed` is intentionally treated as pre-gate too — re-mounting the
 * gate on a failed-onboarding instance would hide the engine's error
 * surface from the user; we'd rather let them see the chat with the
 * failure context.
 *
 * The helper opens NO new SQLite handles — it issues a single SELECT
 * against the supplied ProjectDb. Safe on a brand-new instance: if the
 * `onboarding_state` table doesn't exist (defensive — production always
 * runs migrations at boot before this fires) or the row is absent, the
 * helper returns null and the caller treats that as "pre-bootstrap".
 */

import type { ProjectDb } from '../../persistence/index.ts'

/**
 * Phases at or beyond `max_oauth_offered`. When the owner is in one of
 * these AND has no Anthropic credentials, the composer renders the gate
 * page (matches the original `(returning users must reconnect)` UX).
 *
 * Note: `failed` is NOT in this set — see file header.
 */
export const POST_MAX_OAUTH_PHASES: ReadonlySet<string> = new Set([
  // `max_oauth_offered` / `wow_fired` are NO LONGER walked phases (the engine
  // phase-walk was removed in #243 and their handler methods in #248/K11e), so
  // they are intentionally NOT `OnboardingPhase` members. But pre-#243 managed
  // deployments walked owners THROUGH these phases, so a stranded legacy
  // `onboarding_state.phase` row can still hold either string verbatim. The set
  // is typed `ReadonlySet<string>` so those legacy strings keep classifying as
  // "post-max" — a credential-less owner stuck on a legacy row must still see
  // the Max-OAuth gate, not a regressed real-landing mount.
  'max_oauth_offered',
  'wow_fired',
  'completed',
])

/**
 * Read the current `onboarding_state.phase` for THIS (instance, user).
 * Returns null on:
 *   - missing row (brand-new instance, engine hasn't been started yet)
 *   - missing table (defensive — production always runs migrations)
 *   - malformed phase string (defensive — should not occur)
 *   - any thrown SQLite error (defensive — never crash the composer)
 *
 * ISSUES #2 (2026-05-19) — scoped by (project_slug, user_id). The
 * onboarding_state PK is composite per migration 0034 so an instance
 * with multiple onboarded users has one row per user.
 *
 * Codex r1 P2 (2026-05-12) — the prior shape did
 * `ORDER BY last_advanced_at DESC LIMIT 1` with no filter, so a
 * rename-without-rekey edge case (a stale `onboarding_state` row
 * keyed by an old slug) could outrank the current-slug row and make
 * the composer gate `/chat` based on the wrong phase. Filtering by
 * the composer's `project_slug` instead means the helper is true to
 * "the current instance's phase", and stale rows under different slugs
 * are correctly invisible — a brand-new chat surface for a renamed
 * instance whose rekey failed is the safer fallback than honoring a
 * stale post-`max_oauth_offered` phase.
 *
 * Single SELECT — cheap.
 */
export function loadCurrentOnboardingPhase(
  db: ProjectDb,
  project_slug: string,
  user_id: string,
): string | null {
  try {
    const row = db
      .raw()
      .query<{ phase: string }, [string, string]>(
        `SELECT phase FROM onboarding_state WHERE project_slug = ? AND user_id = ? LIMIT 1`,
      )
      .get(project_slug, user_id)
    if (row === null || row === undefined) return null
    const phase = row.phase
    if (typeof phase !== 'string' || phase.length === 0) return null
    // Return the RAW DB string (not narrowed to `OnboardingPhase`): a stranded
    // legacy row can hold `max_oauth_offered` / `wow_fired`, which are no longer
    // enum members but must still flow through the post-max gate below.
    return phase
  } catch {
    return null
  }
}

/**
 * True when the composer should mount the real chat surface (rather than
 * the Max-OAuth gate page) for an instance with no Anthropic credentials.
 *
 * `null` (brand-new, no engine row yet) → true.
 * pre-`max_oauth_offered` phases → true.
 * `max_oauth_offered` and beyond → false (gate).
 */
export function shouldMountRealLandingWithoutCreds(
  phase: string | null,
): boolean {
  if (phase === null) return true
  return !POST_MAX_OAUTH_PHASES.has(phase)
}
