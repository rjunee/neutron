/**
 * S2 (c) — the per-install session-cookie secret is RANDOM + persisted, never
 * the old guessable `open-ephemeral-<slug>` constant, and is loaded fail-closed
 * against a hostile filesystem:
 *   - existing files are tightened to 0600 (via the fd) or rotated (Blocker #2);
 *   - a first-boot mint race converges on one winner (Medium #3);
 *   - a SYMLINKED secret is never followed/trusted (High — token forgery);
 *   - a too-short (< 16) persisted value is rotated, not trusted (Medium).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MIN_COOKIE_SECRET_LEN,
  resolvePersistedCookieSecret,
  sessionCookieSecretPath,
} from '../session-cookie-secret.ts'

let home: string
const extraDirs: string[] = []

function freshHome(): string {
  const h = mkdtempSync(join(tmpdir(), 'neutron-cookie-secret-'))
  extraDirs.push(h)
  return h
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'neutron-cookie-secret-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  while (extraDirs.length > 0) rmSync(extraDirs.pop()!, { recursive: true, force: true })
})

describe('resolvePersistedCookieSecret', () => {
  it('mints a high-entropy random secret and persists it 0600 under NEUTRON_HOME', () => {
    const secret = resolvePersistedCookieSecret(home)
    expect(secret).toMatch(/^[0-9a-f]{48}$/)
    expect(secret.startsWith('open-ephemeral-')).toBe(false)

    const path = sessionCookieSecretPath(home)
    expect(fs.readFileSync(path, 'utf8').trim()).toBe(secret)
    expect(fs.statSync(path).mode & 0o777).toBe(0o600)
  })

  it('is STABLE across calls (sessions survive a restart)', () => {
    const first = resolvePersistedCookieSecret(home)
    expect(resolvePersistedCookieSecret(home)).toBe(first)
  })

  it('mints DISTINCT secrets per install (per-NEUTRON_HOME)', () => {
    expect(resolvePersistedCookieSecret(home)).not.toBe(resolvePersistedCookieSecret(freshHome()))
  })

  it('High #2 — tightens a pre-existing 0644 secret to 0600 and keeps its value', () => {
    const path = sessionCookieSecretPath(home)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path, 'restored-world-readable-secret\n') // 29 chars ≥ 16
    fs.chmodSync(path, 0o644)
    expect(fs.statSync(path).mode & 0o777).toBe(0o644)

    const secret = resolvePersistedCookieSecret(home)
    expect(secret).toBe('restored-world-readable-secret')
    expect(fs.statSync(path).mode & 0o777).toBe(0o600)
  })

  it('Blocker #2 — an existing secret we CANNOT tighten (fchmod throws) is NOT returned', () => {
    const path = sessionCookieSecretPath(home)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path, 'exposed-secret-value-0123456789\n') // 31 chars ≥ 16
    fs.chmodSync(path, 0o644)

    const spy = spyOn(fs, 'fchmodSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: fchmod not permitted'), { code: 'EPERM' })
    })
    try {
      const secret = resolvePersistedCookieSecret(home)
      expect(secret).not.toBe('exposed-secret-value-0123456789')
      expect(secret).toMatch(/^[0-9a-f]{48}$/)
    } finally {
      spy.mockRestore()
    }
  })

  it('Blocker #2 — a fchmod that silently does NOT take (re-stat still wide) is NOT returned', () => {
    const path = sessionCookieSecretPath(home)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path, 'still-wide-secret-value-0123456789\n') // ≥ 16
    fs.chmodSync(path, 0o644)

    const spy = spyOn(fs, 'fchmodSync').mockImplementation(() => {
      /* pretend it worked, but change nothing */
    })
    try {
      const secret = resolvePersistedCookieSecret(home)
      expect(secret).not.toBe('still-wide-secret-value-0123456789')
      expect(secret).toMatch(/^[0-9a-f]{48}$/)
    } finally {
      spy.mockRestore()
    }
  })

  it('Medium #3 — EEXIST mint race returns the winner value, not a fresh mint', () => {
    const path = sessionCookieSecretPath(home)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path, 'winner-secret-value-0123456789\n', { mode: 0o600 }) // ≥ 16

    // Simulate the TOCTOU: the initial no-follow OPEN misses the file (ENOENT, as
    // if a racing starter creates it just after), forcing the exclusive-create
    // path, which then hits EEXIST and must read back the winner's value.
    const realOpen = fs.openSync
    let n = 0
    const spy = spyOn(fs, 'openSync').mockImplementation((p: fs.PathLike, ...rest: unknown[]) => {
      n += 1
      if (n === 1) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realOpen as any)(p, ...rest)
    })
    try {
      expect(resolvePersistedCookieSecret(home)).toBe('winner-secret-value-0123456789')
    } finally {
      spy.mockRestore()
    }
    expect(n).toBeGreaterThanOrEqual(2) // proves exclusive-create → EEXIST → readback
    expect(fs.readFileSync(path, 'utf8').trim()).toBe('winner-secret-value-0123456789')
  })

  it('High — a SYMLINKED secret is NOT followed/trusted (rotates; never returns planted value)', () => {
    const path = sessionCookieSecretPath(home)
    fs.mkdirSync(home, { recursive: true })
    // Attacker plants a readable 0600 file with a KNOWN value and points the
    // secret path at it via a symlink.
    const targetDir = freshHome()
    const target = join(targetDir, 'attacker-secret')
    fs.writeFileSync(target, 'attacker-known-secret-0123456789\n', { mode: 0o600 })
    fs.symlinkSync(target, path)
    expect(fs.lstatSync(path).isSymbolicLink()).toBe(true)

    const secret = resolvePersistedCookieSecret(home)
    // The planted value is NEVER returned (no-follow open → ELOOP → rotate).
    expect(secret).not.toBe('attacker-known-secret-0123456789')
    expect(secret).toMatch(/^[0-9a-f]{48}$/)
    // The symlink was rotated away → the path is now a real regular file.
    expect(fs.lstatSync(path).isSymbolicLink()).toBe(false)
    expect(fs.lstatSync(path).isFile()).toBe(true)
    // The attacker's own target file is untouched but irrelevant.
    expect(fs.readFileSync(target, 'utf8').trim()).toBe('attacker-known-secret-0123456789')
  })

  it('Medium — a too-short persisted secret (1 / 15 chars) is rotated, not returned', () => {
    for (const weak of ['x', 'a'.repeat(MIN_COOKIE_SECRET_LEN - 1)]) {
      const h = freshHome()
      fs.writeFileSync(sessionCookieSecretPath(h), weak + '\n', { mode: 0o600 })
      const secret = resolvePersistedCookieSecret(h)
      expect(secret).not.toBe(weak)
      expect(secret.length).toBeGreaterThanOrEqual(MIN_COOKIE_SECRET_LEN)
    }
  })

  it('Medium — a persisted secret AT the 16-char floor is accepted (not rotated)', () => {
    const atFloor = 'b'.repeat(MIN_COOKIE_SECRET_LEN)
    fs.writeFileSync(sessionCookieSecretPath(home), atFloor + '\n', { mode: 0o600 })
    expect(resolvePersistedCookieSecret(home)).toBe(atFloor)
  })
})
