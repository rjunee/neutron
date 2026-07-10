/**
 * X2 test fixture — a split-surface Core whose `buildTools` and
 * `buildExtraTools` intentionally OVERLAP on one tool (`split_b`), mirroring
 * the real Tasks pattern (`buildTools` already includes `tasks_pick_next` when
 * `pickNext` is wired, and `buildExtraTools` provides it too). The install
 * composer keeps the `buildTools` handler on overlap WITHOUT emitting false
 * `cores.tool_registration_failed` telemetry. Exercised by
 * `gateway/__tests__/cores-under-implementation-hardfail.test.ts`.
 */

import { defineCore } from '@neutronai/cores-sdk'

export const core = defineCore({
  slug: 'split_core',
  backendKey: 'backend',
  toolNames: ['split_a', 'split_b'],
  buildTools: (_deps: { backend: unknown }) => ({
    split_a: async (): Promise<{ from: 'base' }> => ({ from: 'base' }),
    split_b: async (): Promise<{ from: 'base' }> => ({ from: 'base' }),
  }),
  buildExtraTools: (_deps: { backend: unknown }) => ({
    // Overlaps split_b — the composer keeps the buildTools handler.
    split_b: async (): Promise<{ from: 'extra' }> => ({ from: 'extra' }),
  }),
})
