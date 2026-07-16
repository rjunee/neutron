/**
 * Open-resident STUB `PlatformAdapter` test fixture (ISSUES #223, 2026-06-13).
 *
 * Relocated from `tests/helpers/stub-platform.ts` into the kept Open
 * `runtime/__tests__/` tree (the #219 `start-token-testkit.ts` precedent).
 *
 * WHY THIS LIVES HERE
 * ───────────────────
 * `tests/` is NOT in `scripts/sprint-c/open-paths.txt`, so the Sprint-C
 * carve (`scripts/sprint-c/carve-open-tree.sh`) strips the whole `tests/`
 * subtree from the public Open tree, then runs `bun test` INSIDE that
 * tree as a hard gate. The 26 Open-co-located tests that imported the old
 * `tests/helpers/stub-platform.ts` would `import`-fail in the carved tree
 * and abort the carve (ISSUES #223 — same carve-break class as #219, but
 * a shared-helper-location root cause, not a Managed-dir import). Living
 * under `runtime/__tests__/` — a kept Open path — it carries into the
 * carved tree and the importers resolve.
 *
 * Sprint B (2026-05-20) — stub `PlatformAdapter` for tests that compose
 * the production graph without exercising any platform-tier operations.
 *
 * `CompositionInput.platform` is REQUIRED post-Sprint-B; tests that
 * never reach the adapter wire `STUB_PLATFORM` in three lines:
 *
 *   import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
 *   const composition = { ..., platform: STUB_PLATFORM }
 *
 * The stub is a `LocalPlatformAdapter` against a sentinel instance. Every
 * Managed-only method throws `PlatformOperationUnsupportedError`; the
 * slug-availability probe returns `{available:true}` for every grammar-
 * legal slug. Tests that need a wired adapter (M2 onboarding,
 * connect fan-out) construct their own.
 */

import { buildLocalPlatformAdapter } from '@neutronai/runtime/platform-adapter-local.ts'
import type {
  PlatformAdapter,
  PlatformInstanceInfo,
} from '@neutronai/runtime/platform-adapter.ts'

export const STUB_OWNER: PlatformInstanceInfo = {
  owner_handle: 't-test-stub-0001',
  url_slug: 'stub',
  owner_home: '/tmp/neutron-test-stub',
  agent_name: null,
  tier: 'open',
  kind: 'user',
}

export const STUB_PLATFORM: PlatformAdapter = buildLocalPlatformAdapter({
  selfOwner: STUB_OWNER,
})
