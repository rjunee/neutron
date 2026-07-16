/**
 * @neutronai/gateway/wiring — C8 re-export SHIM (one release).
 *
 * C8 evicted the onboarding finalize ORCHESTRATION out of the composition layer
 * into the product package `onboarding/openings/`. This path-compatibility shim
 * keeps existing importers resolving during the deprecation window; new code
 * should import from `@neutronai/onboarding/openings/finalize.ts` directly. The
 * composition root supplies the create-project seams (`ensureProjectRow`,
 * `materializer`) that used to be imported inside this module.
 */
export * from '@neutronai/onboarding/openings/finalize.ts'
