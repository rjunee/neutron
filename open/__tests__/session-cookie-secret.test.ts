/**
 * S2 (c) — the per-install session-cookie secret is RANDOM + persisted, never
 * the old guessable `open-ephemeral-<slug>` constant. Plus the Codex-found
 * hardenings: existing files are tightened to 0600 (High #2) and a first-boot
 * mint race converges on ONE winner secret (Medium #3).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resolvePersistedCookieSecret,
  sessionCookieSecretPath,
} from '../session-cookie-secret.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'neutron-cookie-secret-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('resolvePersistedCookieSecret', () => {
  it('mints a high-entropy random secret and persists it 0600 under NEUTRON_HOME', () => {
    const secret = resolvePersistedCookieSecret(home)
    // 24 random bytes → 48 hex chars; definitely not the old predictable string.
    expect(secret).toMatch(/^[0-9a-f]{48}$/)
    expect(secret.startsWith('open-ephemeral-')).toBe(false)

    const path = sessionCookieSecretPath(home)
    expect(fs.readFileSync(path, 'utf8').trim()).toBe(secret)
    // 0600 — owner-only (mask off the file-type bits).
    expect(fs.statSync(path).mode & 0o777).toBe(0o600)
  })

  it('is STABLE across calls (sessions survive a restart)', () => {
    const first = resolvePersistedCookieSecret(home)
    const second = resolvePersistedCookieSecret(home)
    expect(second).toBe(first)
  })

  it('mints DISTINCT secrets per install (per-NEUTRON_HOME)', () => {
    const otherHome = mkdtempSync(join(tmpdir(), 'neutron-cookie-secret-'))
    try {
      expect(resolvePersistedCookieSecret(home)).not.toBe(
        resolvePersistedCookieSecret(otherHome),
      )
    } finally {
      rmSync(otherHome, { recursive: true, force: true })
    }
  })

  it('High #2 — tightens a pre-existing 0644 secret to 0600 and keeps its value', () => {
    const path = sessionCookieSecretPath(home)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path, 'restored-world-readable-secret\n')
    fs.chmodSync(path, 0o644) // simulate a restored backup / hand-created file
    expect(fs.statSync(path).mode & 0o777).toBe(0o644)

    const secret = resolvePersistedCookieSecret(home)
    expect(secret).toBe('restored-world-readable-secret')
    // The perms were tightened before we trusted the value.
    expect(fs.statSync(path).mode & 0o777).toBe(0o600)
  })

  it('Medium #3 — EEXIST mint race returns the winner value, not a fresh mint', () => {
    const path = sessionCookieSecretPath(home)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path, 'winner-secret-value\n', { mode: 0o600 })

    // Simulate the TOCTOU: the initial existence check MISSES the file (as if a
    // racing starter creates it just after), forcing the exclusive-create path,
    // which then hits EEXIST and must read back the winner's value.
    let calls = 0
    const spy = spyOn(fs, 'existsSync').mockImplementation(() => {
      calls += 1
      return calls === 1 ? false : true // miss on pre-write check, hit on readback
    })
    try {
      const secret = resolvePersistedCookieSecret(home)
      expect(secret).toBe('winner-secret-value')
    } finally {
      spy.mockRestore()
    }
    // Proves we actually went through the exclusive-create → EEXIST → readback.
    expect(calls).toBeGreaterThanOrEqual(2)
    // The winner's file was never clobbered.
    expect(fs.readFileSync(path, 'utf8').trim()).toBe('winner-secret-value')
  })
})
