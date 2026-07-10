/**
 * X2 test fixture — a split-surface Core that wires a tool ONLY on its extra
 * surface: `buildTools` returns `ew_b` as a NON-CALLABLE placeholder
 * (`undefined`) and `buildExtraTools` returns the real `ew_b` handler.
 *
 * The install merge must let the extra's callable handler WIN over the base
 * placeholder (rather than keeping the placeholder and then wrongly hard-
 * failing the coverage check as `manifest_incomplete`). Exercised by
 * `gateway/__tests__/cores-under-implementation-hardfail.test.ts`.
 */

import { defineCore } from '@neutronai/cores-sdk'

export const core = defineCore({
  slug: 'extrawins_core',
  backendKey: 'backend',
  toolNames: ['ew_a', 'ew_b'],
  buildTools: (_deps: { backend: unknown }) => ({
    ew_a: async (): Promise<{ from: 'base' }> => ({ from: 'base' }),
    // Placeholder — the base surface does NOT implement ew_b.
    ew_b: undefined as unknown as () => Promise<unknown>,
  }),
  buildExtraTools: (_deps: { backend: unknown }) => ({
    ew_b: async (): Promise<{ from: 'extra' }> => ({ from: 'extra' }),
  }),
})
