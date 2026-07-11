/**
 * S2 (c) — the per-install session-cookie secret is RANDOM + persisted, never
 * the old guessable `open-ephemeral-<slug>` constant.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
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
    expect(readFileSync(path, 'utf8').trim()).toBe(secret)
    // 0600 — owner-only (mask off the file-type bits).
    expect(statSync(path).mode & 0o777).toBe(0o600)
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
})
