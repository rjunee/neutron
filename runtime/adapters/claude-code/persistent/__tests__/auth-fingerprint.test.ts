import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authFingerprintFor } from '../repl-session.ts'
import { deriveChildSinkToken } from '../sink-coordinates.ts'

const homes: string[] = []
function tokenPath(): string {
  const home = mkdtempSync(join(tmpdir(), 'neutron-auth-fingerprint-'))
  homes.push(home)
  return join(home, '.sink-token')
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

test('unchanged credentials reproduce a full versioned tag from a persisted protected key', () => {
  const path = tokenPath()
  const env = { ANTHROPIC_API_KEY: 'synthetic-auth-token' }
  const before = authFingerprintFor(env, path)
  const key = readFileSync(path, 'utf8').trim()
  expect(before).toMatch(/^scrypt-v1:[0-9a-f]{64}$/)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(before).not.toContain(env.ANTHROPIC_API_KEY)
  expect(before).not.toContain(key)

  // A separate process has no fingerprint or key cache from the first call.
  const helper = new URL('../repl-session.ts', import.meta.url).pathname
  const restarted = Bun.spawnSync([process.execPath, '-e',
    `const { authFingerprintFor } = await import(process.argv[1]);
     process.stdout.write(authFingerprintFor({ ANTHROPIC_API_KEY: 'synthetic-auth-token' }, process.argv[2]));`,
    helper, path,
  ], { stdout: 'pipe', stderr: 'pipe' })
  expect(restarted.exitCode).toBe(0)
  expect(restarted.stdout.toString()).toBe(before)
  expect(readFileSync(path, 'utf8').trim()).toBe(key)
  // More restrictive permissions remain valid; rekeying would strand survivors.
  chmodSync(path, 0o400)
  expect(authFingerprintFor(env, path)).toBe(before)
})

test('both the actual token and the independent instance key bind the fingerprint', () => {
  const firstPath = tokenPath()
  const secondPath = tokenPath()
  const first = authFingerprintFor({ ANTHROPIC_API_KEY: 'synthetic-before' }, firstPath)
  expect(authFingerprintFor({ ANTHROPIC_API_KEY: 'synthetic-after' }, firstPath)).not.toBe(first)
  expect(authFingerprintFor({ ANTHROPIC_API_KEY: 'synthetic-before' }, secondPath)).not.toBe(first)
  expect(authFingerprintFor({ ANTHROPIC_API_KEY: 'synthetic-before' }, firstPath)).toBe(first)

  const key = readFileSync(firstPath, 'utf8').trim()
  // The same input under the sink's child-credential purpose is a different tag.
  expect(first.split(':')[1]).not.toBe(deriveChildSinkToken(key, 'synthetic-before'))
})

test('ambient auth keeps its explicit empty sentinel without reading or creating a key', () => {
  const path = tokenPath()
  for (const env of [undefined, {}, { ANTHROPIC_API_KEY: undefined },
    { CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: 'ignored-by-precedence' }]) {
    expect(authFingerprintFor(env, path)).toBe('')
  }
  expect(existsSync(path)).toBe(false)
})

test('auth variable precedence stays identical across fingerprint versions', () => {
  const path = tokenPath()
  const chosen = authFingerprintFor({ CLAUDE_CODE_OAUTH_TOKEN: 'chosen' }, path)
  expect(authFingerprintFor({ CLAUDE_CODE_OAUTH_TOKEN: 'chosen',
    ANTHROPIC_AUTH_TOKEN: 'ignored', ANTHROPIC_API_KEY: 'also-ignored' }, path)).toBe(chosen)
  expect(authFingerprintFor({ ANTHROPIC_AUTH_TOKEN: 'chosen', ANTHROPIC_API_KEY: 'ignored' }, path)).toBe(chosen)
  expect(authFingerprintFor({ ANTHROPIC_API_KEY: 'chosen' }, path)).toBe(chosen)
})
