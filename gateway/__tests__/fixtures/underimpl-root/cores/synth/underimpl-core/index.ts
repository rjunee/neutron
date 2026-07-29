/**
 * X2 test fixture — a deliberately UNDER-IMPLEMENTING Core.
 *
 * Its manifest declares two tools (`underimpl_ok`, `underimpl_missing`) but
 * `buildTools` returns a handler for only ONE of them. With a backend factory
 * wired, the install composer's coverage check must HARD-FAIL this Core
 * (`manifest_incomplete`) rather than silently registering a throw-stub for
 * `underimpl_missing`. Exercised by
 * `gateway/__tests__/cores-under-implementation-hardfail.test.ts`.
 *
 * NOT a real bundled Core: it lives under `gateway/__tests__/fixtures/` and is
 * only ever discovered by that test's explicit `rootDirs`.
 */

import { defineCore } from '@neutronai/cores-sdk'

export const core = defineCore({
  slug: 'underimpl_core',
  backendKey: 'backend',
  toolNames: ['underimpl_ok', 'underimpl_missing'],
  buildTools: (_deps: { backend: unknown }) => ({
    // `underimpl_missing` is intentionally absent → under-implementation.
    underimpl_ok: async (): Promise<Record<string, never>> => ({}),
  }),
})
