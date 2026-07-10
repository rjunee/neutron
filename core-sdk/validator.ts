/**
 * @neutronai/core-sdk/validator — ONE-RELEASE PATH SHIM.
 *
 * X3 (one manifest contract) deleted the 650-line hand validator and
 * collapsed validation to the single Zod source, `@neutronai/cores-sdk`
 * (`cores/sdk/manifest.ts`). `validateNeutronManifest` is now GENERATED from
 * that schema (validity decided by `safeParseManifest`, issues mapped to the
 * legacy `ERROR_CODES`, plus the two advisory warnings). This forwarding
 * module preserves the legacy `@neutronai/core-sdk/validator.ts` subpath so
 * existing importers keep resolving during the deprecation window. New code
 * MUST import from `@neutronai/cores-sdk`.
 */

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

export type {
  ValidationError,
  ValidationResult,
  ValidationWarning,
} from '@neutronai/cores-sdk/manifest'
