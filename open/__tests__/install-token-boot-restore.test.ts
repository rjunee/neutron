/**
 * Boot-sequence regression: a previously-persisted install token must be
 * restored into `process.env` BEFORE the composer resolves the LLM substrate.
 *
 * Motivating incident (2026-07-24): an operator running an isolated instance
 * against a shared, read-only code checkout points
 * `NEUTRON_INSTALL_TOKEN_ENV_PATH` at a writable env file OUTSIDE cwd. Bun's
 * cwd-relative `.env` auto-load never sees that file, so without an explicit
 * restore the freshly-booted process resolves NO credential even though a token
 * was captured on a prior boot. `open/server.ts` calls
 * `loadPersistedInstallToken()` early — before both the injected-composer branch
 * and the Open composer's `resolveOpenLlmPool(env)` — to close that gap.
 *
 * Two guards:
 *   1. FUNCTIONAL — restore → resolve yields a live oauth pool from the same env.
 *   2. STRUCTURAL — the restore call precedes substrate resolution in the boot
 *      source, so a future edit can't silently reorder it after the composer.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { loadPersistedInstallToken } from '../install-token-env.ts'
import { resolveOpenLlmPool } from '../composer.ts'

const OVERRIDE_VAR = 'NEUTRON_INSTALL_TOKEN_ENV_PATH'
const TOKEN = 'sk-ant-oat01-' + 'D'.repeat(40)
const HERE = dirname(fileURLToPath(import.meta.url))

let dir: string
let savedOverride: string | undefined
let savedOAuth: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'neutron-boot-restore-'))
  savedOverride = process.env[OVERRIDE_VAR]
  savedOAuth = process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env[OVERRIDE_VAR]
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (savedOverride === undefined) delete process.env[OVERRIDE_VAR]
  else process.env[OVERRIDE_VAR] = savedOverride
  if (savedOAuth === undefined) delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  else process.env['CLAUDE_CODE_OAUTH_TOKEN'] = savedOAuth
})

describe('boot restore → substrate resolution', () => {
  test('a persisted token at the override path resolves a live substrate after restore', () => {
    const envPath = join(dir, 'instance.env')
    writeFileSync(envPath, `PORT=7800\nCLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`)
    process.env[OVERRIDE_VAR] = envPath

    // BEFORE restore: env carries no token → the substrate would gate (null).
    expect(resolveOpenLlmPool(process.env, { probeAmbientAuth: () => false })).toBeNull()

    // The boot step server.ts runs early:
    loadPersistedInstallToken()

    // AFTER restore: the SAME env now resolves a live oauth pool.
    const pool = resolveOpenLlmPool(process.env, { probeAmbientAuth: () => false })
    expect(pool).not.toBeNull()
    expect(pool!.credentials[0]!.kind).toBe('oauth')
    expect(pool!.credentials[0]!.secret).toBe(TOKEN)
  })
})

describe('boot source ordering', () => {
  test('open/server.ts calls loadPersistedInstallToken() before it builds any composer', () => {
    const src = readFileSync(join(HERE, '..', 'server.ts'), 'utf8')
    const restoreAt = src.indexOf('loadPersistedInstallToken()')
    const injectedBootAt = src.indexOf('return boot({ composer: injected')
    const openComposerAt = src.indexOf('buildOpenGraphComposer(')
    expect(restoreAt).toBeGreaterThan(-1)
    expect(injectedBootAt).toBeGreaterThan(-1)
    expect(openComposerAt).toBeGreaterThan(-1)
    // Restore must precede BOTH the injected-composer boot and the Open composer
    // (each resolves an LLM substrate from `process.env` downstream of here).
    expect(restoreAt).toBeLessThan(injectedBootAt)
    expect(restoreAt).toBeLessThan(openComposerAt)
  })
})
