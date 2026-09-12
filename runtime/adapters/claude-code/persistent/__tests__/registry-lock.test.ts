/**
 * registry-lock.test.ts — the flock(2) RMW guard (S2 § 2 row #12). Nova had no
 * standalone registry-lock test (coverage lived in watchdog.test.ts's
 * pruneRegistry blocks); Neutron adds a direct one. The Python-flock-cooperation
 * case is dropped — Neutron has no Python spawn side.
 */

import { describe, it, expect } from 'bun:test'
import { linkSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registryLockPath, withFlockSync } from '../registry-lock.ts'

describe('registry-lock', () => {
  it('derives <dir>/.registry.lock from a registry path', () => {
    expect(registryLockPath('/srv/neutron/.neutron/repl-registry.json')).toBe(
      '/srv/neutron/.neutron/.registry.lock',
    )
  })

  it('refuses a lock path that opens to a NON-REGULAR file, and does not run fn', () => {
    // The fstat check, and the only case that can falsify it. O_NOFOLLOW rejects a
    // symlink and the other non-regular types fail at `open` anyway — a FIFO and a
    // socket answer ENXIO under O_WRONLY|O_NONBLOCK, a directory answers EISDIR — so
    // without a type that OPENS successfully and is not a regular file, the check is
    // unfalsifiable and would be believed rather than tested.
    //
    // `/dev/null` is that type, and it needs no CAP_MKNOD: it opens cleanly with the
    // production flags and `fstat` reports a character device. Without the check,
    // `flock` on it succeeds and `fn` RUNS — so the assertion is that fn does not.
    let ran = false
    expect(() =>
      withFlockSync('/dev/null', () => {
        ran = true
        return 'should not happen'
      }),
    ).toThrow(/not a regular file/)
    expect(ran).toBe(false)
  })

  it('does not truncate a HARD-LINKED target — the lock carries no payload, so it never truncates', () => {
    // O_NOFOLLOW stops a symlink and does nothing about a hard link: the alias IS a
    // regular file, `fstat` agrees, and with O_TRUNC the original would already be empty
    // before any check could run. No ordering of validations fixes a truncation that
    // happens at open, so the destructive flag is gone instead.
    const dir = mkdtempSync(join(tmpdir(), 'neutron-lock-hardlink-'))
    const victim = join(dir, 'precious.txt')
    const contents = 'bytes that must survive\n'
    writeFileSync(victim, contents, { mode: 0o600 })

    const lock = join(dir, '.registry.lock')
    linkSync(victim, lock)

    expect(withFlockSync(lock, () => 'ran')).toBe('ran')
    expect(readFileSync(victim, 'utf8')).toBe(contents)
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
