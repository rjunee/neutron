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

// The platform-known capability set + the KNOWN_* enumerations + the
// structural validator (now GENERATED from the single Zod schema) live with
// that schema. Full legacy surface retained for the one-release deprecation
// window; see also `./validator.ts` for the legacy subpath.
export {
  ERROR_CODES,
  WARNING_CODES,
  KNOWN_CAPABILITIES,
  KNOWN_BILLING_MODELS,
  KNOWN_INSTALL_SCOPES,
  KNOWN_LINKED_SOURCE_KINDS,
  KNOWN_LINKED_SOURCE_SCOPES,
  KNOWN_LINKED_SOURCE_TARGET_KINDS,
  KNOWN_MANIFEST_SECRET_KINDS,
  KNOWN_TIER_SUPPORTS,
  KNOWN_UI_SURFACES,
  isKnownCapability,
  isValidSemverRange,
  validateNeutronManifest,
} from '@neutronai/cores-sdk/manifest'
