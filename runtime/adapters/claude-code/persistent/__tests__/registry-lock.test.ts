/**
 * registry-lock.test.ts — the flock(2) RMW guard (S2 § 2 row #12). Nova had no
 * standalone registry-lock test (coverage lived in watchdog.test.ts's
 * pruneRegistry blocks); Neutron adds a direct one. The Python-flock-cooperation
 * case is dropped — Neutron has no Python spawn side.
 */

import { describe, it, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registryLockPath, withFlockSync } from '../registry-lock.ts'

describe('registry-lock', () => {
  it('derives <dir>/.registry.lock from a registry path', () => {
    expect(registryLockPath('/srv/neutron/.neutron/repl-registry.json')).toBe(
      '/srv/neutron/.neutron/.registry.lock',
    )
  })

  it('runs fn under the lock and returns its value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neutron-lock-'))
    const lock = registryLockPath(join(dir, 'repl-registry.json'))
    const out = withFlockSync(lock, () => 41 + 1)
    expect(out).toBe(42)
  })

  it('creates a missing parent dir before opening the lock (direct-caller path, Codex P2)', () => {
    // A direct caller (proof script / test) may point replRegistryPath at a
    // <dir>/.neutron/ that does not exist yet — the auto-selector pre-creates it,
    // direct callers do not. The lock must self-create so supervision is not
    // silently disabled by an ENOENT on openSync.
    const base = mkdtempSync(join(tmpdir(), 'neutron-lock-'))
    const lock = registryLockPath(join(base, '.neutron', 'repl-registry.json'))
    expect(() => withFlockSync(lock, () => 'ok')).not.toThrow()
    expect(withFlockSync(lock, () => 'ok')).toBe('ok')
  })

  it('serializes nested RMW critical sections (re-entrant-safe ordering)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'neutron-lock-'))
    const lock = registryLockPath(join(dir, 'repl-registry.json'))
    const order: string[] = []
    withFlockSync(lock, () => {
      order.push('outer-start')
      order.push('outer-end')
    })
    withFlockSync(lock, () => {
      order.push('second')
    })
    expect(order).toEqual(['outer-start', 'outer-end', 'second'])
  })
})
