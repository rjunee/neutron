/**
 * S2 (c) — the per-install session-cookie secret is RANDOM + persisted, never
 * the old guessable `open-ephemeral-<slug>` constant, and is loaded fail-closed
 * against a hostile filesystem:
 *   - a value found with perms BROADER than 0600 is COMPROMISED → rotated, not
 *     tightened-and-trusted (High — a later chmod can't un-expose it);
 *   - a first-boot mint race converges on one winner (Medium #3);
 *   - a SYMLINKED secret is never followed/trusted (High — token forgery);
 *   - a too-short (< 16) persisted value is rotated, not trusted (Medium);
 *   - concurrent rotation converges (best-effort) behind an advisory lock: two
 *     real resolvers converge on one on-disk secret; a competitor-held lock is
 *     waited-on + adopted; a stale (crashed-holder) lock is reclaimed; the lock
 *     carries an owner TOKEN so a reclaimed holder's release doesn't delete the
 *     new owner's lock; and a post-acquire RE-VERIFY makes a rotator whose lock
 *     was swapped in the inherent check-then-act window YIELD, not rotate
 *     concurrently (High — the residual window is documented, not falsely closed).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  __cookieSecretTiming,
  __rotateLockInternals,
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

  it('High — a world-readable (0644) secret is COMPROMISED → ROTATED, not tightened-and-trusted', () => {
    const path = sessionCookieSecretPath(home)
    fs.mkdirSync(home, { recursive: true })
    // A known value another local user may have ALREADY read (perms broader than
    // 0600). Merely tightening it later cannot un-expose it → it must be rotated.
    fs.writeFileSync(path, 'world-readable-known-secret-0123456789\n') // ≥ 16
    fs.chmodSync(path, 0o644)
    expect(fs.statSync(path).mode & 0o777).toBe(0o644)

    const secret = resolvePersistedCookieSecret(home)
    // The exposed value is NEVER kept as the signing key…
    expect(secret).not.toBe('world-readable-known-secret-0123456789')
    expect(secret).toMatch(/^[0-9a-f]{48}$/) // …a fresh secret is minted instead
    // …and the on-disk file is now a fresh 0600 value.
    expect(fs.statSync(path).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(path, 'utf8').trim()).toBe(secret)
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

  it('High — ownership token: a reclaimed holder\'s release does NOT delete the new owner\'s lock', () => {
    const lockPath = sessionCookieSecretLockPath(home)
    fs.mkdirSync(home, { recursive: true })

    // A acquires the rotate lock, then STALLS — we backdate its lock past the
    // stale threshold to simulate a paused/crashed-looking holder.
    const heldA = __rotateLockInternals.acquire(lockPath)
    expect(heldA).not.toBeNull()
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lockPath, old, old)

    // B observes A's lock as (confirmed) stale, RECLAIMS it, and now owns the
    // lock under ITS OWN unique token — B is mid-rotation, still holding it.
    const heldB = __rotateLockInternals.acquire(lockPath)
    expect(heldB).not.toBeNull()
    expect(heldB!.token).not.toBe(heldA!.token)

    // A resumes and releases. It MUST NOT remove B's live lock — the pathname no
    // longer carries A's token. (Dropping the release token check → A unlinks B's
    // lock → this assertion + the C assertion below go red.)
    __rotateLockInternals.release(heldA!, lockPath)
    expect(fs.existsSync(lockPath)).toBe(true) // B's lock survived A's release

    // C now tries to rotate: it sees B's live (fresh, non-stale) lock and must
    // WAIT/adopt — it must NOT acquire and rotate concurrently with B.
    const heldC = __rotateLockInternals.acquire(lockPath)
    expect(heldC).toBeNull() // no concurrent rotation

    // B finishes and releases its OWN lock (token matches) → lock removed.
    __rotateLockInternals.release(heldB!, lockPath)
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it('High — post-acquire re-verify: a lock SWAPPED between stamp and check makes the rotator YIELD', () => {
    const lockPath = sessionCookieSecretLockPath(home)
    fs.mkdirSync(home, { recursive: true })

    // Deterministically drive the inherent pathname-lockfile window: right after
    // A stamps its token (our first writeSync), a racer SWAPS the lock — unlinks
    // A's file and recreates the pathname under a DIFFERENT owner token, exactly
    // in the check-then-act gap. The post-acquire re-verify must catch the
    // foreign token and YIELD (acquire → null) instead of returning a lock A no
    // longer owns (which would let A rotate concurrently with the racer).
    const realWrite = fs.writeSync
    let swapped = false
    const spy = spyOn(fs, 'writeSync').mockImplementation((fd: number, ...rest: unknown[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const n = (realWrite as any)(fd, ...rest) // A stamps ITS token first…
      if (!swapped) {
        swapped = true // guard: the racer's own writeSync below must not re-enter
        try {
          fs.unlinkSync(lockPath)
        } catch {
          /* non-fatal */
        }
        const racer = fs.openSync(
          lockPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
          0o600,
        )
        fs.writeSync(racer, 'racer.777.222')
        fs.closeSync(racer)
      }
      return n
    })
    let held: ReturnType<typeof __rotateLockInternals.acquire>
    try {
      held = __rotateLockInternals.acquire(lockPath)
    } finally {
      spy.mockRestore()
    }

    expect(swapped).toBe(true) // the swap happened in the window
    // WITH the re-verify: A notices the on-disk token is no longer its own and
    // YIELDS. (Dropping the re-verify → A returns a non-null held lock it doesn't
    // own → TWO concurrent rotators → this assertion goes red.)
    expect(held).toBeNull()
    // A did NOT delete the racer's lock on its way out.
    expect(fs.existsSync(lockPath)).toBe(true)
    expect(fs.readFileSync(lockPath, 'utf8').trim()).toBe('racer.777.222')
  })
})
