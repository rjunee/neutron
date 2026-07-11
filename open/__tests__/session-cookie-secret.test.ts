/**
 * S2 (c) — the per-install session-cookie secret is RANDOM + persisted, never
 * the old guessable `open-ephemeral-<slug>` constant, and is loaded fail-closed
 * against a hostile filesystem:
 *   - existing files are tightened to 0600 (via the fd) or rotated (Blocker #2);
 *   - a first-boot mint race converges on one winner (Medium #3);
 *   - a SYMLINKED secret is never followed/trusted (High — token forgery);
 *   - a too-short (< 16) persisted value is rotated, not trusted (Medium);
 *   - concurrent rotation is FIRST-WRITER-WINS behind an exclusive lock: two
 *     real resolvers converge on one on-disk secret; a competitor-held lock is
 *     waited-on + adopted; a stale (crashed-holder) lock is reclaimed.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  __cookieSecretTiming,
  MIN_COOKIE_SECRET_LEN,
  resolvePersistedCookieSecret,
  sessionCookieSecretLockPath,
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

  it('Medium — TWO real competing resolvers CONVERGE first-writer-wins (one home)', () => {
    const path = sessionCookieSecretPath(home)
    const lockPath = sessionCookieSecretLockPath(home)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path, 'x\n', { mode: 0o600 }) // weak → rejected → BOTH must rotate

    // Drive TWO genuinely competing resolver invocations against the SAME home
    // (not a mocked rename to a predetermined value — that can't detect a
    // post-read overwrite). Interleave at the moment resolver A tries to CREATE
    // the rotate lock: right before A's exclusive-create, run resolver B to
    // completion. B wins the lock, mints the winner, releases. Control returns to
    // A, which then creates the lock, RE-READS the target under the lock, sees
    // B's winner, and ADOPTS it — never minting a second, diverging secret.
    const realOpen = fs.openSync
    let interleaved = false
    let bSecret = ''
    const spy = spyOn(fs, 'openSync').mockImplementation((p: fs.PathLike, ...rest: unknown[]) => {
      if (p === lockPath && !interleaved) {
        interleaved = true // guard: B's own lock-create must NOT re-trigger this
        bSecret = resolvePersistedCookieSecret(home) // B runs fully, wins, releases
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realOpen as any)(p, ...rest)
    })
    let aSecret: string
    try {
      aSecret = resolvePersistedCookieSecret(home)
    } finally {
      spy.mockRestore()
    }

    // Both resolvers actually ran the rotation path (removing the lock — reverting
    // to last-writer rename — leaves the lock unopened → interleaved stays false).
    expect(interleaved).toBe(true)
    expect(bSecret).toMatch(/^[0-9a-f]{48}$/)
    // First-writer-wins: BOTH returned values are EQUAL and equal the FINAL
    // on-disk value. (Dropping the under-lock re-read makes A mint + overwrite →
    // aSecret ≠ bSecret ≠ on-disk → these go red.)
    expect(aSecret).toBe(bSecret)
    expect(aSecret).not.toBe('x') // never the old weak value
    expect(fs.readFileSync(path, 'utf8').trim()).toBe(bSecret)
    // Regular 0600 non-symlink target.
    expect(fs.lstatSync(path).isSymbolicLink()).toBe(false)
    expect(fs.lstatSync(path).isFile()).toBe(true)
    expect(fs.statSync(path).mode & 0o777).toBe(0o600)
  })

  it('Medium — a competitor-held lock makes us WAIT and ADOPT their secret', () => {
    const path = sessionCookieSecretPath(home)
    const lockPath = sessionCookieSecretLockPath(home)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path, 'x\n', { mode: 0o600 }) // weak → we must rotate…
    fs.writeFileSync(lockPath, '', { mode: 0o600 }) // …but a fresh (non-stale) lock is held

    const WINNER = 'competitor-installed-secret-0123456789'
    // The competitor finishes while we wait: on our first wait-sleep their valid
    // secret lands at the target, and our next re-read must ADOPT it — we must
    // NOT mint our own (which would diverge from the lock holder's value).
    let waits = 0
    const sleepSpy = spyOn(__cookieSecretTiming, 'sleep').mockImplementation(() => {
      waits += 1
      fs.writeFileSync(path, WINNER + '\n', { mode: 0o600 })
    })
    let secret: string
    try {
      secret = resolvePersistedCookieSecret(home)
    } finally {
      sleepSpy.mockRestore()
    }
    expect(secret).toBe(WINNER) // adopted the holder's secret…
    expect(secret).not.toMatch(/^[0-9a-f]{48}$/) // …did NOT mint our own 48-hex
    expect(waits).toBeGreaterThan(0) // we actually waited (didn't mint immediately)
    expect(fs.existsSync(lockPath)).toBe(true) // did NOT steal the live lock
    expect(fs.readFileSync(path, 'utf8').trim()).toBe(WINNER)
  })

  it('Medium — a STALE rotate lock (crashed holder) is reclaimed, then we rotate', () => {
    const path = sessionCookieSecretPath(home)
    const lockPath = sessionCookieSecretLockPath(home)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path, 'x\n', { mode: 0o600 }) // weak → must rotate
    fs.writeFileSync(lockPath, '', { mode: 0o600 })
    // Backdate the lock far beyond the stale threshold → crashed-holder orphan.
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lockPath, old, old)

    const secret = resolvePersistedCookieSecret(home)
    expect(secret).toMatch(/^[0-9a-f]{48}$/) // reclaimed the orphan + minted a real secret
    expect(secret).not.toBe('x')
    expect(fs.readFileSync(path, 'utf8').trim()).toBe(secret)
    expect(fs.existsSync(lockPath)).toBe(false) // reclaimed lock released, not left dangling
  })
})
