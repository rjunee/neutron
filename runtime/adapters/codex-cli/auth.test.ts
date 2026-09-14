import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CODEX_CLI_AUTH_ENV_VARS, resolveCodexAuth } from './auth.ts'

const REQUIRED_CODEX_AUTH_ENV_VARS = [
  'OPENAI_API_KEY',
  'OPENAI_KEY',
  'OPENAI_AUTH_TOKEN',
  'OPENAI_API_TOKEN',
  'CODEX_ACCESS_TOKEN',
] as const

test('one Codex auth vocabulary feeds the adapter and both wrappers', () => {
  expect(CODEX_CLI_AUTH_ENV_VARS).toEqual(REQUIRED_CODEX_AUTH_ENV_VARS)
  const repoRoot = join(import.meta.dir, '../../..')
  for (const wrapper of ['codex-review.sh', 'codex-build.sh']) {
    const source = readFileSync(join(repoRoot, 'trident', wrapper), 'utf8')
    expect(source).toContain('../config/codex-cli-auth-env-vars.txt')
    expect(source).not.toMatch(/unset\s+OPENAI_/u)
  }

  // A newly hand-maintained shell scrub in trident is a divergence, even in a
  // wrapper this test does not know by name.
  for (const name of readdirSync(join(repoRoot, 'trident')).filter((name) => name.endsWith('.sh'))) {
    expect(readFileSync(join(repoRoot, 'trident', name), 'utf8')).not.toMatch(/unset[^\n]*OPENAI_/u)
  }
})

describe('codex-cli auth', () => {
  test('OPENAI_API_KEY wins over persisted OAuth', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-auth-'))
    try {
      writeFileSync(join(dir, 'auth.json'), '{"access_token":"old"}')
      const out = await resolveCodexAuth({
        env: { OPENAI_API_KEY: 'sk-byo' },
        codex_home: dir,
      })
      expect(out.source).toBe('api_key')
      expect(out.spawn_env['OPENAI_API_KEY']).toBe('sk-byo')
      expect(out.codex_home).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('falls back to codex_oauth when auth.json exists in CODEX_HOME', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-auth-'))
    try {
      writeFileSync(join(dir, 'auth.json'), '{"access_token":"sub"}')
      const out = await resolveCodexAuth({ env: {}, codex_home: dir })
      expect(out.source).toBe('codex_oauth')
      expect(out.spawn_env['CODEX_HOME']).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('throws actionable error when neither path resolves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-auth-'))
    try {
      await expect(resolveCodexAuth({ env: {}, codex_home: dir })).rejects.toThrow(
        /no auth resolved.*codex login.*OPENAI_API_KEY/s,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('CODEX_HOME env var is honored when codex_home option absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-auth-'))
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'auth.json'), '{}')
      const out = await resolveCodexAuth({ env: { CODEX_HOME: dir } })
      expect(out.source).toBe('codex_oauth')
      expect(out.codex_home).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('ISSUES #67 — api_key path: spawn_env carries undefined for the unselected variants', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-auth-'))
    try {
      const out = await resolveCodexAuth({
        env: { OPENAI_API_KEY: 'sk-byo' },
        codex_home: dir,
      })
      expect(out.source).toBe('api_key')
      expect(out.spawn_env['OPENAI_API_KEY']).toBe('sk-byo')
      // The unselected Codex auth variants ARE keys on the object (so
      // exec.ts's `Object.entries` iteration sees them and drops them
      // from parentEnv), with their values set to `undefined`.
      for (const k of CODEX_CLI_AUTH_ENV_VARS) {
        if (k === 'OPENAI_API_KEY') continue
        expect(Object.prototype.hasOwnProperty.call(out.spawn_env, k)).toBe(true)
        expect(out.spawn_env[k]).toBeUndefined()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('ISSUES #67 — codex_oauth path: spawn_env carries undefined for every Codex auth variant', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-auth-'))
    try {
      writeFileSync(join(dir, 'auth.json'), '{"access_token":"sub"}')
      const out = await resolveCodexAuth({ env: {}, codex_home: dir })
      expect(out.source).toBe('codex_oauth')
      // OAuth path sets NO env-var credential — the persisted file under
      // CODEX_HOME is the credential. Every Codex auth env var should be
      // present-as-undefined so exec.ts can drop any host-inherited copy.
      for (const k of CODEX_CLI_AUTH_ENV_VARS) {
        expect(Object.prototype.hasOwnProperty.call(out.spawn_env, k)).toBe(true)
        expect(out.spawn_env[k]).toBeUndefined()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
