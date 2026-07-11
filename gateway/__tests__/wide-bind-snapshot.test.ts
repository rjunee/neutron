/**
 * S2 (b) Blocker A — the wide-bind guard must read the SAME env SNAPSHOT the
 * BootConfig was resolved from, NOT live `process.env`. `boot()` takes a
 * pre-resolved config precisely so it never re-reads the environment; the guard
 * has to honor that. These drive the guard THROUGH `boot()`:
 *   - config resolved WITH a bypass active + ambient env cleared → boot REFUSED
 *     (proves it reads the snapshot, not the now-clean live env);
 *   - config resolved CLEAN + ambient bypass set → boots (proves it ignores the
 *     live env, judging only the snapshot).
 * The pure `assertWideBindPolicy` unit tests live in `boot-bind-policy.test.ts`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { boot } from '../index.ts'
import { assertWideBindPolicy } from '../boot-bind-policy.ts'
import { resolveBootConfig } from '@neutronai/config/index.ts'

const roots: string[] = []
const SAVED_KEYS = [
  'NEUTRON_DEV_AUTH',
  'NEUTRON_APP_WS_BYPASS',
  'NEUTRON_APP_WS_DEV_SECRET',
  'NEUTRON_E2E_DEV_SECRET',
  'NOTIFY_SOCKET',
] as const
const saved: Record<string, string | undefined> = {}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
  for (const k of SAVED_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function snapshotEnv(): void {
  for (const k of SAVED_KEYS) saved[k] = process.env[k]
  delete process.env['NOTIFY_SOCKET']
}

function configFor(root: string, extra: Record<string, string>) {
  return resolveBootConfig({
    NEUTRON_DB_PATH: join(root, 'owner.db'),
    NEUTRON_INSTANCE_SLUG: 'alice',
    ...extra,
  })
}

describe('S2 (b) Blocker A — wide-bind guard reads the config snapshot', () => {
  test('bypass ACTIVE in the snapshot + ambient env CLEARED → boot REFUSED', async () => {
    const root = mkdtempSync(join(tmpdir(), 'neutron-s2-snap-'))
    roots.push(root)
    snapshotEnv()
    // Snapshot captures the bypass at resolution time…
    const config = configFor(root, { NEUTRON_HOST: '0.0.0.0', NEUTRON_DEV_AUTH: '1' })
    // …and the live env no longer has it — the guard must still refuse.
    delete process.env['NEUTRON_DEV_AUTH']
    await expect(boot({ config, port: 0 })).rejects.toThrow(/NEUTRON_DEV_AUTH/)
  })

  test('snapshot CLEAN + ambient bypass SET after resolution → guard IGNORES live env', () => {
    // The env-layer guard reads ONLY the config snapshot: a clean snapshot is
    // NOT rejected just because the live process.env later gains a bypass var.
    // (We assert the guard directly rather than through a full wide `boot()` — a
    // clean *env-layer* pass does NOT mean a clean wide bind is safe to expose;
    // the real credential gate — rejecting the predictable `dev:owner` on a wide
    // bind — is the COMPOSER's job, proven by the composition e2e
    // `wide-bind-dev-owner-rejected.open.test.ts`.)
    const root = mkdtempSync(join(tmpdir(), 'neutron-s2-snap-'))
    roots.push(root)
    snapshotEnv()
    const config = configFor(root, { NEUTRON_HOST: '0.0.0.0' }) // no bypass in snapshot
    process.env['NEUTRON_APP_WS_DEV_SECRET'] = 'ambient-should-be-ignored'
    expect(() => assertWideBindPolicy(config.host, config.devBypassEnv)).not.toThrow()
  })
})
