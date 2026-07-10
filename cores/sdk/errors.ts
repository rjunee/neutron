/**
 * @neutronai/cores-sdk — unified capability-denial error.
 *
 * Refactor X4 (item 4): `CapabilityDeniedError` was duplicated with two
 * DIVERGENT shapes that only shared the `name` string (an `instanceof`
 * footgun across bands):
 *
 *   - `cores/sdk/secrets.ts` — thrown at secret-access time when a Core
 *     reads a `(kind, label)` its manifest never declared. 2-arg ctor
 *     `(message, code='capability_denied')`; codes `capability_denied |
 *     not_found | misconfigured`.
 *   - `cores/runtime/errors.ts` — thrown at tool-dispatch time when a Core
 *     calls a tool/capability its manifest never declared. 3-arg ctor
 *     `(code, message, { core_id, tool_name?, capability? })`; codes
 *     `capability_not_declared | tool_not_declared | capability_mismatch |
 *     manifest_missing`.
 *
 * They live in the same band-visible surface (secrets is contracts-band
 * `cores/sdk`; the runtime version is services-band `cores/runtime`, which
 * imports `cores/sdk`), so the single definition lives here in the LOWER
 * band and the runtime re-exports it. One class, one `instanceof` identity,
 * the union of both code sets, all context fields optional so BOTH surfaces
 * construct it without positional ambiguity (options-object ctor).
 */

/** Union of both denial surfaces' codes. The first three belong to the
 *  secret-access surface; the remaining four to the tool-dispatch surface. */
export type CapabilityDeniedCode =
  // secret-access surface (cores/sdk/secrets.ts)
  | 'capability_denied'
  | 'not_found'
  | 'misconfigured'
  // tool-dispatch surface (cores/runtime/capability-guard.ts)
  | 'capability_not_declared'
  | 'tool_not_declared'
  | 'capability_mismatch'
  | 'manifest_missing'

export interface CapabilityDeniedErrorInit {
  code: CapabilityDeniedCode
  message: string
  /** Tool-dispatch surface only: the Core whose dispatch was denied. */
  core_id?: string
  /** Tool-dispatch surface only: the tool that was called. */
  tool_name?: string
  /** Tool-dispatch surface only: the capability that was missing/mismatched. */
  capability?: string
}

export class CapabilityDeniedError extends Error {
  override readonly name = 'CapabilityDeniedError'
  readonly code: CapabilityDeniedCode
  readonly core_id?: string
  readonly tool_name?: string
  readonly capability?: string
  constructor(init: CapabilityDeniedErrorInit) {
    super(init.message)
    this.code = init.code
    if (init.core_id !== undefined) this.core_id = init.core_id
    if (init.tool_name !== undefined) this.tool_name = init.tool_name
    if (init.capability !== undefined) this.capability = init.capability
  }
}
