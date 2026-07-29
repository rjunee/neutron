/**
 * X2 test fixture — a Core that returns a NON-FUNCTION for a declared tool.
 *
 * `buildTools` returns `nonfn_bad: undefined` (a property that exists but is
 * not callable). The install composer's coverage check must treat this as
 * under-implementation (`manifest_incomplete`), not accept it and later crash
 * when `wrapHandler` invokes it. Exercised by
 * `gateway/__tests__/cores-under-implementation-hardfail.test.ts`.
 */

import { defineCore } from '@neutronai/cores-sdk'

export const core = defineCore({
  slug: 'nonfn_core',
  backendKey: 'backend',
  toolNames: ['nonfn_ok', 'nonfn_bad'],
  buildTools: (_deps: { backend: unknown }) => ({
    nonfn_ok: async (): Promise<Record<string, never>> => ({}),
    // Declared in the manifest + toolNames, but NOT a callable handler.
    nonfn_bad: undefined as unknown as () => Promise<unknown>,
  }),
})
