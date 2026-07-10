/**
 * X2 test fixture — a Core whose defineCore().toolNames DRIFT from its manifest.
 *
 * The manifest declares two tools (`tn_a`, `tn_b`) and `buildTools` implements
 * BOTH (so the coverage check would pass), but the contract's `toolNames`
 * declares only `tn_a`. The install composer must hard-fail with
 * `core_contract_mismatch` — the typed contract must stay authoritative over
 * the manifest, not silently disagree with it.
 */

import { defineCore } from '@neutronai/cores-sdk'

export const core = defineCore({
  slug: 'tnmatch_core',
  backendKey: 'backend',
  toolNames: ['tn_a'],
  buildTools: (_deps: { backend: unknown }) => ({
    tn_a: async (): Promise<Record<string, never>> => ({}),
    tn_b: async (): Promise<Record<string, never>> => ({}),
  }),
})
