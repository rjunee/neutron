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
    const res = resolveOwnerBearer(home, { [OWNER_BEARER_ENV_VAR]: `  ${'z'.repeat(20)}  \n` })
    expect(res.value).toBe('z'.repeat(20))
    expect(res.source).toBe('env')
  })

  it('FAILS LOUD on a too-short explicit env bearer (never silently downgrades)', () => {
    expect(() =>
      resolveOwnerBearer(home, { [OWNER_BEARER_ENV_VAR]: 'a'.repeat(OWNER_BEARER_MIN_LEN - 1) }),
    ).toThrow(new RegExp(OWNER_BEARER_ENV_VAR))
    // A value AT the floor is accepted.
    const atFloor = 'b'.repeat(OWNER_BEARER_MIN_LEN)
    expect(resolveOwnerBearer(home, { [OWNER_BEARER_ENV_VAR]: atFloor })).toEqual({
      value: atFloor,
      source: 'env',
    })
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
})
