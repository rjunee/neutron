/**
 * Unit tests for `persistOauthTokenToEnv` — the durable side of the install-
 * token handoff. Mirrors install.sh's `persist_oauth_token_to_env`: replace an
 * existing (possibly `export`-prefixed) line, else append, without disturbing
 * other keys.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { persistOauthTokenToEnv } from '../install-token-env.ts'

const TOKEN = 'sk-ant-oat01-' + 'B'.repeat(40)
let dir: string
let envPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'neutron-env-'))
  envPath = join(dir, '.env')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
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

  test('repeated writes do not accumulate blank lines', () => {
    persistOauthTokenToEnv(TOKEN, envPath)
    persistOauthTokenToEnv(TOKEN + 'C', envPath)
    const out = readFileSync(envPath, 'utf8')
    expect(out).not.toContain('\n\n')
    expect((out.match(/CLAUDE_CODE_OAUTH_TOKEN=/g) ?? []).length).toBe(1)
  })
})
