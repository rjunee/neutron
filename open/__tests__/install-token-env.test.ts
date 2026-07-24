/**
 * Unit tests for `persistOauthTokenToEnv` — the durable side of the install-
 * token handoff. Mirrors install.sh's `persist_oauth_token_to_env`: replace an
 * existing (possibly `export`-prefixed) line, else append, without disturbing
 * other keys.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  loadPersistedInstallToken,
  persistOauthTokenToEnv,
  resolveInstallTokenEnvFilePath,
} from '../install-token-env.ts'

const OVERRIDE_VAR = 'NEUTRON_INSTALL_TOKEN_ENV_PATH'
const TOKEN = 'sk-ant-oat01-' + 'B'.repeat(40)
let dir: string
let envPath: string
let savedOverride: string | undefined
let savedOAuth: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'neutron-env-'))
  envPath = join(dir, '.env')
  // Snapshot the two env vars these suites mutate so nothing leaks cross-test.
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

describe('persistOauthTokenToEnv', () => {
  test('creates .env with the token when none exists', () => {
    persistOauthTokenToEnv(TOKEN, envPath)
    expect(readFileSync(envPath, 'utf8')).toBe(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`)
  })

  test('appends without disturbing other keys', () => {
    writeFileSync(envPath, 'PORT=7800\nNEUTRON_HOME=/x\n')
    persistOauthTokenToEnv(TOKEN, envPath)
    const out = readFileSync(envPath, 'utf8')
    expect(out).toContain('PORT=7800')
    expect(out).toContain('NEUTRON_HOME=/x')
    expect(out).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`)
  })

  test('replaces an existing token line (plain + export-prefixed) and does not duplicate', () => {
    writeFileSync(envPath, 'PORT=7800\nexport CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-old\n')
    persistOauthTokenToEnv(TOKEN, envPath)
    const out = readFileSync(envPath, 'utf8')
    expect((out.match(/CLAUDE_CODE_OAUTH_TOKEN=/g) ?? []).length).toBe(1)
    expect(out).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`)
    expect(out).not.toContain('sk-ant-oat01-old')
    expect(out).toContain('PORT=7800')
  })

  test('tightens an existing world-readable .env to 0600 (secret hygiene)', () => {
    writeFileSync(envPath, 'PORT=7800\n')
    chmodSync(envPath, 0o644) // pre-existing permissive file
    persistOauthTokenToEnv(TOKEN, envPath)
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
  })

  test('repeated writes do not accumulate blank lines', () => {
    persistOauthTokenToEnv(TOKEN, envPath)
    persistOauthTokenToEnv(TOKEN + 'C', envPath)
    const out = readFileSync(envPath, 'utf8')
    expect(out).not.toContain('\n\n')
    expect((out.match(/CLAUDE_CODE_OAUTH_TOKEN=/g) ?? []).length).toBe(1)
  })
})

describe('resolveInstallTokenEnvFilePath — override path resolution', () => {
  test('defaults to <cwd>/.env when the override var is unset', () => {
    expect(resolveInstallTokenEnvFilePath()).toBe(join(process.cwd(), '.env'))
  })

  test('an empty / whitespace-only override is treated as unset (falls back to cwd/.env)', () => {
    process.env[OVERRIDE_VAR] = '   '
    expect(resolveInstallTokenEnvFilePath()).toBe(join(process.cwd(), '.env'))
  })

  test('returns the (trimmed) override path when set', () => {
    process.env[OVERRIDE_VAR] = `  ${envPath}  `
    expect(resolveInstallTokenEnvFilePath()).toBe(envPath)
  })
})

describe('persistOauthTokenToEnv — honors the override path via the default parameter', () => {
  test('unset override → writes to <cwd>/.env (default behavior UNCHANGED)', () => {
    // Prove the default parameter still resolves to cwd/.env when unset, without
    // clobbering a real repo .env: assert the resolver, not a live cwd write.
    expect(resolveInstallTokenEnvFilePath()).toBe(join(process.cwd(), '.env'))
    // And an explicit path still wins over the default, exactly as before.
    persistOauthTokenToEnv(TOKEN, envPath)
    expect(readFileSync(envPath, 'utf8')).toBe(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`)
  })

  test('override set → the default parameter routes the write to THAT path', () => {
    process.env[OVERRIDE_VAR] = envPath
    persistOauthTokenToEnv(TOKEN) // no explicit path → default = resolver
    expect(readFileSync(envPath, 'utf8')).toBe(`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`)
  })
})

describe('loadPersistedInstallToken — boot-time restore from the persisted path', () => {
  test('restores CLAUDE_CODE_OAUTH_TOKEN from the override path when unset', () => {
    writeFileSync(envPath, `PORT=7800\nCLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`)
    process.env[OVERRIDE_VAR] = envPath
    expect(process.env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined()
    loadPersistedInstallToken()
    expect(process.env['CLAUDE_CODE_OAUTH_TOKEN']).toBe(TOKEN)
  })

  test('restores an export-prefixed token line too', () => {
    writeFileSync(envPath, `export CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`)
    process.env[OVERRIDE_VAR] = envPath
    loadPersistedInstallToken()
    expect(process.env['CLAUDE_CODE_OAUTH_TOKEN']).toBe(TOKEN)
  })

  test('NEVER clobbers an already-set token (explicit credential wins)', () => {
    writeFileSync(envPath, `CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`)
    process.env[OVERRIDE_VAR] = envPath
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'sk-ant-oat01-already-set'
    loadPersistedInstallToken()
    expect(process.env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-already-set')
  })

  test('missing file is a no-op (box boots credential-less)', () => {
    process.env[OVERRIDE_VAR] = join(dir, 'does-not-exist.env')
    loadPersistedInstallToken()
    expect(process.env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined()
  })

  test('file present but no token line is a no-op', () => {
    writeFileSync(envPath, 'PORT=7800\nNEUTRON_HOME=/x\n')
    process.env[OVERRIDE_VAR] = envPath
    loadPersistedInstallToken()
    expect(process.env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined()
  })

  test('round-trips with persistOauthTokenToEnv over the same override path', () => {
    process.env[OVERRIDE_VAR] = envPath
    persistOauthTokenToEnv(TOKEN) // writes to the override path
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN'] // simulate a fresh boot
    loadPersistedInstallToken() // next boot restores it
    expect(process.env['CLAUDE_CODE_OAUTH_TOKEN']).toBe(TOKEN)
  })
})
