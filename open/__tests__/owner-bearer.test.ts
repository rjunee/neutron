/**
 * S1 — per-install OWNER BEARER credential boundary tests.
 *
 * The owner bearer is the single credential the app-ws resolver + every
 * /api/app/* surface accept as the owner. It must be:
 *   - operator-overridable via NEUTRON_OWNER_BEARER (a too-short explicit value
 *     FAILS LOUD — a misconfiguration never silently downgrades);
 *   - otherwise a per-INSTALL random bearer PERSISTED 0600 under NEUTRON_HOME,
 *     STABLE across restarts and DISTINCT per install;
 *   - loaded through the shared hardened core (a compromised 0644 / symlinked
 *     value is rotated, never trusted);
 *   - reported with a `source` (`env`/`persisted`/`ephemeral`) so a wide-bind
 *     boot can fail closed on a NON-persistent (ephemeral) bearer.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  OWNER_BEARER_ENV_VAR,
  OWNER_BEARER_MIN_LEN,
  hasSufficientBearerEntropy,
  isValidThreadedBearer,
  ownerBearerLockPath,
  ownerBearerPath,
  resolveOwnerBearer,
  selectAppWsToken,
} from '../owner-bearer.ts'

let home: string
const extraDirs: string[] = []

function freshHome(): string {
  const h = mkdtempSync(join(tmpdir(), 'neutron-owner-bearer-'))
  extraDirs.push(h)
  return h
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'neutron-owner-bearer-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  while (extraDirs.length > 0) rmSync(extraDirs.pop()!, { recursive: true, force: true })
})

describe('resolveOwnerBearer — env override', () => {
  it('uses an operator-set NEUTRON_OWNER_BEARER verbatim (source=env)', () => {
    const bearer = 'operator-configured-high-entropy-bearer-0123456789'
    const res = resolveOwnerBearer(home, { [OWNER_BEARER_ENV_VAR]: bearer })
    expect(res).toEqual({ value: bearer, source: 'env' })
    // An env override does NOT touch disk.
    expect(fs.existsSync(ownerBearerPath(home))).toBe(false)
  })

  it('TRIMS surrounding whitespace on the env override (both sides use the trimmed value)', () => {
    const strong = 'kZ2mR4nT6vB0cD5eG9h' // 19 chars, high entropy
    const res = resolveOwnerBearer(home, { [OWNER_BEARER_ENV_VAR]: `  ${strong}  \n` })
    expect(res.value).toBe(strong)
    expect(res.source).toBe('env')
  })

  it('FAILS LOUD on a too-short explicit env bearer (never silently downgrades)', () => {
    expect(() =>
      resolveOwnerBearer(home, { [OWNER_BEARER_ENV_VAR]: 'a'.repeat(OWNER_BEARER_MIN_LEN - 1) }),
    ).toThrow(new RegExp(OWNER_BEARER_ENV_VAR))
    // A HIGH-ENTROPY value AT the floor is accepted.
    const atFloor = 'a3F9kZ2mQ7pX1sW8' // 16 chars, high entropy
    expect(resolveOwnerBearer(home, { [OWNER_BEARER_ENV_VAR]: atFloor })).toEqual({
      value: atFloor,
      source: 'env',
    })
  })

  /** Full decoded content of a writeSync buffer/string arg (offset/len ignored so a
   *  matcher stays stable across a partial-write loop's re-calls on the same buffer). */
  function fullWriteContent(data: unknown): string {
    if (typeof data === 'string') return data
    if (data instanceof Uint8Array) {
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
    }
    return ''
  }

  /** Spy writeSync so ONLY writes whose full content matches `target` are short-written
   *  (flush 4 bytes then stall); every other write (incl. the OTHER of lock/secret)
   *  delegates to the real fs. Returns a hit counter to assert the target was reached. */
  function spyShortWriteMatching(target: (content: string) => boolean): {
    hits: () => number
    spy: ReturnType<typeof spyOn>
  } {
    const realWrite = fs.writeSync.bind(fs)
    let hits = 0
    const spy = spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      data: unknown,
      ...rest: unknown[]
    ): number => {
      if (target(fullWriteContent(data))) {
        hits += 1
        return hits === 1 ? 4 : 0
      }
      return (realWrite as (fd: number, data: unknown, ...r: unknown[]) => number)(fd, data, ...rest)
    }) as typeof fs.writeSync)
    return { hits: () => hits, spy }
  }

  it('a SHORT write on the SECRET file does NOT persist a TRUNCATED bearer — falls back to ephemeral (Codex Medium)', () => {
    // Short-circuit ONLY the minted-secret write ('nbt_…'); the lock-token write
    // delegates to real fs so lock acquisition succeeds and the secret loop is reached.
    const m = spyShortWriteMatching((c) => c.startsWith('nbt_'))
    try {
      const res = resolveOwnerBearer(home, {})
      expect(m.hits()).toBeGreaterThan(0) // the SECRET loop was actually reached
      // Aborted → NOT persisted, and no truncated target file was installed.
      expect(res.source).not.toBe('persisted')
      expect(fs.existsSync(ownerBearerPath(home))).toBe(false)
    } finally {
      m.spy.mockRestore()
    }
  })

  it('a SHORT write on the LOCK TOKEN yields ephemeral WITHOUT leaving a bogus lockfile (Codex Medium)', () => {
    // Short-circuit ONLY the lock-token write (`pid.seq.time`). Pre-fix this left a
    // truncated token → verify-mismatch → a stale lockfile that blocks rotation and
    // forces ephemeral. With the full-write loop, the short write ABORTS and unlinks.
    const m = spyShortWriteMatching((c) => /^\d+\.\d+\.\d+/.test(c))
    try {
      const res = resolveOwnerBearer(home, {})
      expect(m.hits()).toBeGreaterThan(0) // the LOCK-token loop was actually reached
      expect(res.source).toBe('ephemeral') // couldn't secure the lock → ephemeral
      // The failed lock write unlinked its own lockfile — no bogus lock left behind.
      expect(fs.existsSync(ownerBearerLockPath(home))).toBe(false)
    } finally {
      m.spy.mockRestore()
    }
  })

  it('a persisted 0600 but LOW-ENTROPY .owner-bearer file is ROTATED, not trusted (Codex High)', () => {
    // Plant a guessable but length-clearing bearer at the target path, 0600.
    const path = ownerBearerPath(home)
    fs.writeFileSync(path, `${'a'.repeat(20)}\n`, { mode: 0o600 })
    fs.chmodSync(path, 0o600)
    const res = resolveOwnerBearer(home, {})
    // The weak file is rotated to a fresh MINTED bearer, not returned verbatim.
    expect(res.value).not.toBe('a'.repeat(20))
    expect(res.value).toMatch(/^nbt_/)
    expect(hasSufficientBearerEntropy(res.value)).toBe(true)
  })

  it('treats an EMPTY / whitespace-only env override as UNSET → mints+persists', () => {
    for (const raw of ['', '   ', '\t\n']) {
      const h = freshHome()
      const res = resolveOwnerBearer(h, { [OWNER_BEARER_ENV_VAR]: raw })
      expect(res.source).toBe('persisted')
      expect(res.value).toMatch(/^nbt_[A-Za-z0-9_-]+$/)
    }
  })
})

describe('resolveOwnerBearer — persisted per-install', () => {
  it('mints a fresh unguessable nbt_ bearer, persisted 0600 (source=persisted)', () => {
    const res = resolveOwnerBearer(home, {})
    expect(res.source).toBe('persisted')
    expect(res.value).toMatch(/^nbt_[A-Za-z0-9_-]{20,}$/)
    expect(res.value.length).toBeGreaterThanOrEqual(OWNER_BEARER_MIN_LEN)

    const path = ownerBearerPath(home)
    expect(fs.readFileSync(path, 'utf8').trim()).toBe(res.value)
    expect(fs.statSync(path).mode & 0o777).toBe(0o600)
  })

  it('is STABLE across calls (native clients survive a restart)', () => {
    const first = resolveOwnerBearer(home, {})
    const again = resolveOwnerBearer(home, {})
    expect(again.value).toBe(first.value)
    expect(again.source).toBe('persisted')
  })

  it('mints DISTINCT bearers per install (per-NEUTRON_HOME)', () => {
    expect(resolveOwnerBearer(home, {}).value).not.toBe(resolveOwnerBearer(freshHome(), {}).value)
  })

  it('rides the hardened core: a world-readable (0644) bearer is ROTATED, not trusted', () => {
    const path = ownerBearerPath(home)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path, 'world-readable-known-bearer-0123456789\n')
    fs.chmodSync(path, 0o644)

    const res = resolveOwnerBearer(home, {})
    expect(res.value).not.toBe('world-readable-known-bearer-0123456789')
    expect(res.value).toMatch(/^nbt_/)
    expect(res.source).toBe('persisted')
    expect(fs.statSync(path).mode & 0o777).toBe(0o600)
  })

  it('rides the hardened core: a SYMLINKED bearer is NOT followed/trusted', () => {
    const path = ownerBearerPath(home)
    fs.mkdirSync(home, { recursive: true })
    const targetDir = freshHome()
    const target = join(targetDir, 'attacker-bearer')
    fs.writeFileSync(target, 'attacker-known-bearer-0123456789\n', { mode: 0o600 })
    fs.symlinkSync(target, path)

    const res = resolveOwnerBearer(home, {})
    expect(res.value).not.toBe('attacker-known-bearer-0123456789')
    expect(res.value).toMatch(/^nbt_/)
    expect(fs.lstatSync(path).isSymbolicLink()).toBe(false)
  })

  it('reports source=ephemeral when the bearer canNOT be persisted (FS failure)', () => {
    // Let the rotate LOCK create succeed but force the atomic-install temp write
    // to fail (its openSync throws) → the loader falls to a process-ephemeral
    // bearer. This is the exact condition the wide-bind boot guard fails closed on.
    const realOpen = fs.openSync
    const spy = spyOn(fs, 'openSync').mockImplementation((p: fs.PathLike, ...rest: unknown[]) => {
      if (typeof p === 'string' && p.includes('.owner-bearer.tmp')) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realOpen as any)(p, ...rest)
    })
    let res: ReturnType<typeof resolveOwnerBearer>
    try {
      res = resolveOwnerBearer(home, {})
    } finally {
      spy.mockRestore()
    }
    expect(res.source).toBe('ephemeral')
    expect(res.value).toMatch(/^nbt_/) // still unguessable — never a constant
  })
})

describe('selectAppWsToken — composer-side boundary (Codex r1 Critical)', () => {
  it('uses a real threaded bearer VERBATIM (trimmed)', () => {
    expect(selectAppWsToken('nbt_a-real-per-install-owner-bearer-0123456789')).toBe(
      'nbt_a-real-per-install-owner-bearer-0123456789',
    )
    expect(selectAppWsToken('  padded-operator-bearer-0123456789  ')).toBe(
      'padded-operator-bearer-0123456789',
    )
  })

  it('NEVER returns a whitespace-only / empty / unset value — mints instead', () => {
    // The exact server-to-composer hole: a stray `NEUTRON_OWNER_BEARER='   '`
    // must NOT become a guessable few-spaces owner credential.
    for (const raw of ['   ', '\t', ' \n ', '', undefined]) {
      const token = selectAppWsToken(raw)
      expect(token).toMatch(/^nbt_[A-Za-z0-9_-]{20,}$/)
      expect(token.trim()).toBe(token) // never whitespace-laden
      expect(token.length).toBeGreaterThanOrEqual(OWNER_BEARER_MIN_LEN)
    }
  })

  it('mints a DISTINCT token each call for the unset case (unguessable)', () => {
    expect(selectAppWsToken(undefined)).not.toBe(selectAppWsToken(undefined))
  })

  it('enforces the LENGTH + ENTROPY floor on a threaded value (short OR low-entropy reject; strong accept)', () => {
    // A composer-direct wide bind must NOT accept a weaker credential than the
    // server entrypoint. isValidThreadedBearer mirrors resolveOwnerBearer's floors.
    const strong = 'a3F9kZ2mQ7pX1sW8' // 16 chars, all distinct → high entropy
    expect(isValidThreadedBearer(undefined)).toBe(false)
    expect(isValidThreadedBearer('')).toBe(false)
    expect(isValidThreadedBearer('a')).toBe(false) // 1 char
    expect(isValidThreadedBearer('a'.repeat(OWNER_BEARER_MIN_LEN - 1))).toBe(false) // 15
    // Length floor MET but LOW ENTROPY → rejected (Codex High: 'a'×16 is guessable).
    expect(isValidThreadedBearer('a'.repeat(OWNER_BEARER_MIN_LEN))).toBe(false)
    expect(isValidThreadedBearer('ab'.repeat(OWNER_BEARER_MIN_LEN / 2))).toBe(false) // 2-char cycle
    // Length + entropy both met → accepted.
    expect(isValidThreadedBearer(strong)).toBe(true)
    expect(isValidThreadedBearer(`  ${strong}  `)).toBe(true) // trims

    // selectAppWsToken never RETURNS a below-floor OR low-entropy value — it mints.
    for (const weak of [
      '',
      'a',
      'a'.repeat(OWNER_BEARER_MIN_LEN - 1),
      'a'.repeat(OWNER_BEARER_MIN_LEN), // length OK, entropy too low
    ]) {
      const token = selectAppWsToken(weak)
      expect(token).toMatch(/^nbt_/)
      expect(token).not.toBe(weak)
    }
    // …and uses a HIGH-ENTROPY value AT the floor verbatim.
    expect(selectAppWsToken(strong)).toBe(strong)
  })

  it('rejects mechanically-degenerate explicit bearers — repeated, cyclic, AND SEQUENTIAL (Codex High)', () => {
    // The mechanical-degeneracy filter refuses the OBVIOUS guessable shapes: repeated
    // ('a'×16), short cycles ('ab'×8), and MONOTONIC SEQUENCES ('abcdefghijklmnop',
    // '0123456789abcdef') — the exact wide-bind repros. resolveOwnerBearer throws.
    for (const weak of [
      'a'.repeat(16),
      'ab'.repeat(8),
      'abcabcabcabcabca',
      'abcdefghijklmnop', // ascending run
      '0123456789abcdef', // ascending run (digits → hex)
      'ponmlkjihgfedcba', // descending run
    ]) {
      expect(() => resolveOwnerBearer('/tmp/does-not-matter', { [OWNER_BEARER_ENV_VAR]: weak })).toThrow(
        /low-entropy|too short/i,
      )
    }
    // A high-entropy explicit bearer is accepted as source:'env'.
    const strong = 'kQ7pX1sW8a3F9kZ2mR4nT6vB0cD5eG9h'
    expect(resolveOwnerBearer('/tmp/does-not-matter', { [OWNER_BEARER_ENV_VAR]: strong })).toEqual({
      value: strong,
      source: 'env',
    })
  })

  it('KNOWN LIMIT — a dictionary-diverse operator value passes the mechanical filter (the minted default is the guarantee)', () => {
    // Guessability detection is an unwinnable heuristic arms race: a dictionary value
    // with case variation ('passwordPASSWORD') has real character diversity, no
    // repeat/cycle, and no monotonic run, so the mechanical filter CANNOT reject it.
    // This is DOCUMENTED, not a defect: the CRYPTOGRAPHIC guarantee is the auto-MINTED
    // bearer (operators should leave NEUTRON_OWNER_BEARER unset). An operator who both
    // sets a weak-but-diverse bearer AND binds wide has overridden that guarantee
    // against the documented guidance. This test PINS that boundary so a future change
    // to the filter's scope is a conscious decision, not an accident.
    expect(hasSufficientBearerEntropy('passwordPASSWORD')).toBe(true)
    // …whereas the auto-minted bearer is always strong.
    const minted = resolveOwnerBearer(home, {}).value
    expect(minted).toMatch(/^nbt_/)
    expect(hasSufficientBearerEntropy(minted)).toBe(true)
  })
})

describe('resolveOwnerBearer — no cross-install leak via shared env (Codex r3 High)', () => {
  it('does NOT mutate the passed env, so two homes get DISTINCT persisted bearers', () => {
    // Models two in-process starts under DIFFERENT NEUTRON_HOME sharing one env
    // bag. If resolveOwnerBearer wrote its minted value back into env, the second
    // home would misread it as an operator `source: 'env'` bearer and skip its own
    // per-install file — two installs sharing one bearer. It must not.
    const sharedEnv: Record<string, string | undefined> = {}
    const homeA = home
    const homeB = freshHome()

    const a = resolveOwnerBearer(homeA, sharedEnv)
    expect(a.source).toBe('persisted')
    // The env bag is untouched — no write-back promotes the minted value.
    expect(sharedEnv[OWNER_BEARER_ENV_VAR]).toBeUndefined()

    const b = resolveOwnerBearer(homeB, sharedEnv)
    expect(b.source).toBe('persisted') // resolved from B's OWN file, not env
    expect(b.value).not.toBe(a.value) // distinct per install — no leak
  })
})
