/**
 * @neutronai/cores-runtime — public barrel.
 *
 * Sprint 31. The runtime layer that consumes the Sprint 24
 * `@neutronai/cores-sdk` SDK: install / uninstall / upgrade Cores,
 * audit-log every secret op + tool-call capability check, allocate
 * per-Core data namespaces, gate tool dispatch on the manifest's
 * declared capabilities, compose bundled-free Cores at boot.
 *
 * Cross-refs:
 *   docs/plans/2026-05-08-sprint-31-cores-runtime.md
 *   docs/engineering-plan.md § B.P3, § D.10.4, § D.10.5, § A.3
 *   cores/sdk/SDK-CONTRACT.md (the Core-author surface this runtime
 *     consumes)
 */

export const __MODULE__ = '@neutronai/cores-runtime' as const

export {
  CapabilityDeniedError,
  CoreInstallError,
  type CapabilityDeniedErrorCode,
  type CoreInstallErrorCode,
} from './errors.ts'

export {
  findCoreDirs,
  loadCoreFromDir,
  packageNameToSlug,
  readCorePackage,
  type CorePackageJson,
  type LoadedCore,
} from './loader.ts'

// X4 item 1 — shared Core manifest loader (was ×9 copy-paste).
export {
  loadManifestFromPackageDir,
  loadManifestFromPackageJson,
} from './manifest-loader.ts'

// X4 item 2 — shared per-project sidecar resolver + universal traversal guard.
export {
  CorePathTraversalError,
  ProjectSidecarResolver,
  safeResolveProjectRoot,
  type PathTraversalErrorFactory,
  type ProjectSidecarInit,
  type ProjectSidecarResolverOptions,
  type SafeResolveProjectRootOptions,
} from './project-sidecar.ts'

// X4 item 3 — shared Core chat-command-filter contract (was ×3 clones).
export {
  type CoreChatCommandFilter,
  type CoreChatCommandFilterError,
  type CoreChatCommandFilterInput,
  type CoreChatCommandFilterResult,
} from './chat-command-filter.ts'

export {
  CoreInstallationsStore,
  mintInstallEventId,
  type CoreDataLayout,
  type CoreInstallationRecord,
  type CoreGlobalInstallationRecord,
  type InstallationsStoreOptions,
  type RecordInstallInput,
  type RecordGlobalInstallInput,
  type UpdateVersionInput,
} from './installations-store.ts'

export {
  SecretAuditLog,
  buildAuditedSecretsStore,
  type SecretAuditEntry,
  type SecretAuditLogOptions,
  type SecretAuditOp,
  type SecretAuditOutcome,
} from './secret-audit.ts'

export {
  allocateCoreNamespace,
  checkSqlNamespace,
  decideDataLayout,
  openSidecar,
  releaseCoreNamespace,
  runScopedSql,
  sidecarDbPath,
  tablePrefix,
  type AllocateNamespaceInput,
  type CoreNamespace,
  type CoreNamespaceSidecar,
  type CoreNamespaceTables,
} from './data-namespace.ts'

export {
  CapabilityGuard,
  type CapabilityGuardOptions,
  type ToolCheckInput,
  type ToolCheckResult,
} from './capability-guard.ts'

export {
  configureCore,
  installCore,
  installCoreGlobally,
  manifestSupportsScope,
  startCore,
  stopCore,
  uninstallCore,
  uninstallCoreGlobally,
  upgradeCore,
  type ConfigureCoreInput,
  type InstallCoreInput,
  type InstallCoreResult,
  type InstallCoreGloballyInput,
  type SecretsPrompter,
  type UninstallCoreInput,
  type UninstallCoreGloballyInput,
  type UpgradeCoreInput,
  type UpgradeCoreResult,
} from './lifecycle.ts'

export {
  buildBundledRegistry,
  type BuildBundledRegistryOptions,
  type BundledCore,
  type BundledRegistry,
  type BundledRegistryDuplicateSlugEvent,
  type BundledRegistryEvent,
  type BundledRegistryRootSkippedEvent,
  type BundledRegistryTelemetry,
} from './bundled-registry.ts'
