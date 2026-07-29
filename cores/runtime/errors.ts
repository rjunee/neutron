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
  // WAVE 3 PR-2 — a global install was attempted for a Core whose manifest
  // `install_scopes` does not include 'global'.
  | 'scope_not_supported'
  // Refactor X2 — the Core's built tool surface UNDER-IMPLEMENTS its
  // manifest: a backend was wired and `buildTools`/`buildExtraTools` ran,
  // but one or more manifest-declared tools got no callable handler.
  // Formerly a silent throw-stub + log line (ISSUE #330); now a hard install
  // failure so a Core that under-implements its manifest cannot install
  // silently-broken (surfaces as `install_state: 'failed'` in /api/cores).
  | 'manifest_incomplete'
  // Refactor X2 — the Core's `defineCore()` contract MISDECLARES its identity:
  // its declared `slug` disagrees with the package-resolved slug, or its
  // declared `toolNames` drift from the manifest's `tools[]`. A dynamically
  // discovered Core (custom `rootDirs`) is otherwise trusted for its
  // backendKey + factories; this hard-fail keeps the typed contract
  // authoritative rather than letting a misdeclared Core install.
  | 'core_contract_mismatch'

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

/** The tool-dispatch subset of the unified `CapabilityDeniedCode`. Kept as
 *  a named type for callers that branch on the dispatch-surface codes. */
export type CapabilityDeniedErrorCode =
  | 'capability_not_declared'
  | 'tool_not_declared'
  | 'capability_mismatch'
  | 'manifest_missing'

// Refactor X4 (item 4): `CapabilityDeniedError` is now the SINGLE unified
// definition in the lower `cores/sdk` band (`cores/sdk/errors.ts`), shared
// with the secret-access surface. Re-exported here so every tool-layer
// consumer (the 9 bundled cores + `capability-guard.ts`) keeps importing it
// from `@neutronai/cores-runtime` unchanged, and so `instanceof` is one
// identity across both surfaces.
export {
  CapabilityDeniedError,
  type CapabilityDeniedCode,
  type CapabilityDeniedErrorInit,
} from '@neutronai/cores-sdk'
