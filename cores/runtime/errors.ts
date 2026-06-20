/**
 * @neutronai/cores-runtime — typed error surface.
 *
 * Cores runtime errors carry a stable `code` so callers can branch on the
 * failure mode without parsing messages. Two error families:
 *
 *   - `CoreInstallError` — thrown at install / upgrade / load time when a
 *     Core's manifest, package, or namespace cannot be allocated. Always
 *     a Core-author or operator bug; surfaces in admin UI + Telegram
 *     install transcript.
 *
 *   - `CapabilityDeniedError` — thrown at tool-dispatch time when a Core
 *     calls a tool that is not declared in its manifest's `capabilities[]`
 *     OR whose `capability_required` doesn't match a declared capability.
 *     Mirrors `cores/sdk/secrets.ts:CapabilityDeniedError` but for tool
 *     dispatch, so a Core sees one consistent error shape across both
 *     surfaces.
 */

export type CoreInstallErrorCode =
  | 'package_not_found'
  | 'package_json_unreadable'
  | 'no_neutron_section'
  | 'manifest_invalid'
  | 'duplicate_install'
  | 'data_layout_change_not_supported'
  | 'sidecar_path_collision'
  | 'capability_escalation_requires_consent'
  | 'unknown_core'
  | 'sql_namespace_violation'

export class CoreInstallError extends Error {
  override readonly name = 'CoreInstallError'
  readonly code: CoreInstallErrorCode
  readonly details?: Record<string, unknown>
  constructor(
    code: CoreInstallErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export type CapabilityDeniedErrorCode =
  | 'capability_not_declared'
  | 'tool_not_declared'
  | 'capability_mismatch'
  | 'manifest_missing'

export class CapabilityDeniedError extends Error {
  override readonly name = 'CapabilityDeniedError'
  readonly code: CapabilityDeniedErrorCode
  readonly core_id: string
  readonly tool_name?: string
  readonly capability?: string
  constructor(
    code: CapabilityDeniedErrorCode,
    message: string,
    context: {
      core_id: string
      tool_name?: string
      capability?: string
    },
  ) {
    super(message)
    this.code = code
    this.core_id = context.core_id
    if (context.tool_name !== undefined) this.tool_name = context.tool_name
    if (context.capability !== undefined) this.capability = context.capability
  }
}
