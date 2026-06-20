/**
 * @neutronai/core-sdk — public barrel.
 *
 * Cores depend on this package to declare their `"neutron"` manifest section
 * and (in P3) to call platform APIs through capability-gated subpaths. P0
 * Sprint 2B ships only the manifest contract surface; capability subpaths
 * land in P1+.
 */

export const __MODULE__ = '@neutronai/core-sdk' as const

export type {
  BillingHookDef,
  BillingModel,
  JsonSchemaDocument,
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

export {
  ERROR_CODES,
  KNOWN_BILLING_MODELS,
  KNOWN_CAPABILITIES,
  KNOWN_LINKED_SOURCE_KINDS,
  KNOWN_LINKED_SOURCE_SCOPES,
  KNOWN_LINKED_SOURCE_TARGET_KINDS,
  KNOWN_MANIFEST_SECRET_KINDS,
  KNOWN_TIER_SUPPORTS,
  KNOWN_UI_SURFACES,
  WARNING_CODES,
  isValidSemverRange,
  validateNeutronManifest,
} from './validator.ts'
