/**
 * @neutronai/gateway/realmode-composer — Pass-2 Sonnet-fallback telemetry
 * hook factory (P2-v2 S22, 2026-05-17).
 *
 * Per Argus R2 follow-up (S21): the `importOnSonnetFallback` callback
 * parameter shipped on `buildLandingStack` in S21 had ZERO production
 * call site, so the `onboarding.pass2_sonnet_fallback_used` metric
 * stayed silent in production despite the underlying fallback path
 * firing on every Opus 429.
 *
 * This module factors out the production closure shape so:
 *   1. `buildDefaultRealModeComposer` (provisioning composer) wires it.
 *   2. The integration test in
 *      `tests/integration/pass2-sonnet-fallback-telemetry-wiring.test.ts`
 *      exercises the SAME closure end-to-end through `buildLandingStack`'s
 *      internal `buildOnboardingEnginePieces` path.
 *
 * Decoupling the closure from the composer keeps both call sites in sync
 * — a future change to the event payload shape (e.g. adding `attempt_id`
 * to the closure's surface) lands in one place.
 */

import type { OnboardingTelemetry } from '../../onboarding/telemetry/index.ts'
import type { Pass2SonnetFallbackHook } from '../../onboarding/history-import/index.ts'

export interface BuildPass2SonnetFallbackTelemetryHookInput {
  /** Per-instance telemetry sink — captured by closure. */
  telemetry: OnboardingTelemetry
  /**
   * Live resolver for the current `project_slug` (url_slug). Called at
   * emit-time — not at composer-build time — so a no-restart slug
   * rename mid-import emits the fallback event under the NEW slug.
   *
   * This mirrors the `importUrlSlugResolver` pattern used by the
   * budget-warning callback in the same composer; the two paths must
   * stay symmetric or `OnboardingTelemetry.resolveAttemptId` mints-on-
   * miss keyed off the stale slug → fresh `onboarding_state` row →
   * split attempt bucket → corrupted onboarding state. See PR #133
   * (Argus R3 IMPORTANT) for the full failure mode.
   */
  project_slug_resolver: () => string
  /**
   * User id used as the `user_id` field on the emitted event.
   * Production sources this from `registryRow.owner_user_id`
   * (single user per instance in M2 onboarding); `owner_user_id` is
   * stable for the instance lifetime, so unlike `project_slug` this
   * one is safely captured by value at composer-build time.
   */
  user_id: string
}

/**
 * Build the production `Pass2SonnetFallbackHook` closure: when the
 * substrate caller's 429-fallback path fires, emit
 * `onboarding.pass2_sonnet_fallback_used` with the live `project_slug`
 * (resolved at emit time via `project_slug_resolver`), captured
 * `user_id`, and the per-fallback info (synthesizer model, primary
 * model, original 429 message). `attempt_id` is resolved by
 * `OnboardingTelemetry`'s `resolveAttemptId` hook so the row falls
 * into the same per-attempt bucket as every other event.
 *
 * The slug is resolved on every call rather than captured by value
 * to mirror the budget-warning callback's `importUrlSlugResolver`
 * pattern; a no-restart slug rename mid-import must NOT split the
 * attempt bucket. See `BuildPass2SonnetFallbackTelemetryHookInput`
 * for the failure mode.
 *
 * A telemetry-emit failure must NOT abort the user-visible Sonnet
 * fallback dispatch — the substrate caller already catches hook
 * throws, but we belt-and-suspenders here so a telemetry write
 * failure during high-load can't silently break the fallback path.
 */
export function buildPass2SonnetFallbackTelemetryHook(
  input: BuildPass2SonnetFallbackTelemetryHookInput,
): Pass2SonnetFallbackHook {
  const { telemetry, project_slug_resolver, user_id } = input
  return async (info) => {
    // Resolve the slug AT EMIT TIME (not at composer-build time) so a
    // no-restart rename between fallback-armed and fallback-fired emits
    // the event under the new slug — same contract as the budget-
    // warning callback's `importUrlSlugResolver`.
    const project_slug = project_slug_resolver()
    try {
      await telemetry.emit({
        project_slug,
        user_id,
        event: 'onboarding.pass2_sonnet_fallback_used',
        payload: {
          reason: info.reason,
          // `source` is threaded through `Pass2LlmCall` input by the
          // runner (P2-v2 S22); legacy test mocks that omit source
          // result in `info.source` being undefined here — fall back
          // to a stable sentinel so the event payload's required
          // `source` field stays populated.
          source:
            typeof info.source === 'string' && info.source.length > 0
              ? info.source
              : 'pass2_synthesis',
          synthesizer_model: info.synthesizer_model,
          primary_model: info.primary_model,
          primary_error_message: info.primary_error_message,
        },
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[buildPass2SonnetFallbackTelemetryHook] project=${project_slug} onboarding.pass2_sonnet_fallback_used emit failed:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}
