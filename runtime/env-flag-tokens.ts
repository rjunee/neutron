/**
 * @neutronai/runtime — shared opt-in / opt-out token vocabulary.
 *
 * P2-v3 S2 (2026-05-18) — extracted from `phase-spec-resolver.ts:817-834`
 * so the new `NEUTRON_ONBOARDING_CONVERSATIONAL` parser and the existing
 * `NEUTRON_LLM_ONBOARDING_PHASES` / `_DEFAULT` parser share one
 * vocabulary. Avoids drift between two hand-rolled lists.
 *
 * Tokens are case-insensitive; callers `.toLowerCase()` before checking.
 *
 * - `OPTOUT_TOKENS` — interpreted as "no phases / feature off".
 * - `OPTIN_TOKENS` — interpreted as "all phases / feature on".
 *
 * Anything not in either set is interpreted by the caller (typically as a
 * comma-separated phase list).
 */

export const OPTOUT_TOKENS: ReadonlySet<string> = new Set([
  'off',
  'none',
  'disabled',
  'no',
  'false',
  '0',
  '',
])

export const OPTIN_TOKENS: ReadonlySet<string> = new Set([
  '1',
  'true',
  'yes',
  'on',
  'enabled',
  'all',
])

/** Convenience predicate — true iff `raw.toLowerCase()` is in OPTOUT_TOKENS. */
export function isOptOutToken(raw: string): boolean {
  return OPTOUT_TOKENS.has(raw.toLowerCase())
}

/** Convenience predicate — true iff `raw.toLowerCase()` is in OPTIN_TOKENS. */
export function isOptInToken(raw: string): boolean {
  return OPTIN_TOKENS.has(raw.toLowerCase())
}
