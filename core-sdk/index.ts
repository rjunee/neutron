/**
 * @neutronai/core-sdk — public barrel (ONE-RELEASE PATH SHIM).
 *
 * X3 folded this package's manifest contract into the single Zod source
 * `@neutronai/cores-sdk`. The hand validator + JSON-schema mirror (zero
 * production callers) were deleted; this barrel now re-exports the pure
 * manifest types + the platform-known capability set from the single
 * source. New code MUST import from `@neutronai/cores-sdk`.
 */

export const __MODULE__ = '@neutronai/core-sdk' as const

export type {
  BillingHookDef,
  BillingModel,
  Capability,
  InstallScope,
  JsonSchemaDocument,
  KnownCapability,
  LinkedSourceDef,
  LinkedSourceKind,
  LinkedSourceScope,
  LinkedSourceTargetKind,
  ManifestSecret,
  ManifestSecretKind,
  NeutronBuild,
  NeutronCapability,
  NeutronCompat,
  NeutronManifest,
  TierSupport,
  ToolDef,
  UiComponentDef,
  UiComponentSurface,
  ValidationError,
  ValidationResult,
  ValidationWarning,
} from './types.ts'

// The platform-known capability set (formerly hand-maintained in
// validator.ts as KNOWN_CAPABILITIES) + the structural validator (now a thin
// adapter GENERATED from the single Zod schema) live with that schema.
export {
  ERROR_CODES,
  WARNING_CODES,
  KNOWN_CAPABILITIES,
  isKnownCapability,
  isValidSemverRange,
  validateNeutronManifest,
} from '@neutronai/cores-sdk/manifest'
