/**
 * @neutronai/gateway/wiring — C8 re-export SHIM (one release).
 *
 * C8 evicted the onboarding opening-message COMPOSITION helpers out of the
 * composition layer into the product package `onboarding/openings/` (the module
 * is no longer a "handoff hook" — the phase-machine hook was retired by K11 —
 * it is pure opening-message prose composition). New code should import from
 * `@neutronai/onboarding/openings/project-opening.ts` directly.
 */
export * from '@neutronai/onboarding/openings/project-opening.ts'
