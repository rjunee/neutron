/**
 * X2 test fixture — a Core whose defineCore() DECLARES the wrong slug.
 *
 * The package name `@neutronai/slugmatch-core` resolves (via
 * `packageNameToSlug`) to `slugmatch_core`, but the contract below declares
 * `slug: 'impostor_core'`. The install composer must hard-fail with
 * `core_contract_mismatch` rather than trust the misdeclared identity.
 */

import { defineCore } from '@neutronai/cores-sdk'

export const core = defineCore({
  slug: 'impostor_core',
  backendKey: 'backend',
  toolNames: ['sm_do'],
  buildTools: (_deps: { backend: unknown }) => ({
    sm_do: async (): Promise<Record<string, never>> => ({}),
  }),
})
