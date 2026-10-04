import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authFingerprintFor } from '../repl-session.ts'
import { deriveChildSinkToken } from '../sink-coordinates.ts'
import * as capacity from '../../../../workers/claude-capacity-client.ts'

const routeFingerprint = capacity.nativeRelayRouteFingerprint
let routeLookup: ReturnType<typeof spyOn<typeof capacity, 'nativeRelayRouteFingerprint'>>
beforeEach(() => {
  // These credential fixtures model an UNREGISTERED self-host, regardless of
  // whether the machine running the suite has a protected relay registration.
  routeLookup = spyOn(capacity, 'nativeRelayRouteFingerprint').mockReturnValue(undefined)
})

const homes: string[] = []
function tokenPath(): string {
  const home = mkdtempSync(join(tmpdir(), 'neutron-auth-fingerprint-'))
  homes.push(home)
  return join(home, '.sink-token')
}

afterEach(() => {
  routeLookup.mockRestore()
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
  const capacityHelper = new URL('../../../../workers/claude-capacity-client.ts', import.meta.url).pathname
  const restarted = Bun.spawnSync([process.execPath, '-e',
    `const { spyOn } = await import('bun:test');
     const capacity = await import(process.argv[3]);
     const routeLookup = spyOn(capacity, 'nativeRelayRouteFingerprint').mockReturnValue(undefined);
     const { authFingerprintFor } = await import(process.argv[1]);
     try {
       process.stdout.write(authFingerprintFor({ ANTHROPIC_API_KEY: 'synthetic-auth-token' }, process.argv[2]));
     } finally { routeLookup.mockRestore(); }`,
    helper, path, capacityHelper,
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

test('a registered route overrides credentials without creating a fingerprint key', () => {
  const path = tokenPath()
  const { publicKey } = generateKeyPairSync('ed25519')
  const pin: capacity.ClaudeCapacityPin = { version: 1, hostId: 'synthetic-host', instanceId: 'synthetic-instance',
    socketPath: '/synthetic/relay.sock', claudeConfigDir: '/synthetic/claude',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  const route = routeFingerprint(pin)
  if (route === undefined) throw new Error('Synthetic registered route must have a fingerprint')
  routeLookup.mockImplementation(() => routeFingerprint(pin))
  expect(route).toMatch(/^native-relay-v3:[0-9a-f]{64}$/)
  expect(authFingerprintFor(undefined, path)).toBe(route)
  expect(authFingerprintFor({ ANTHROPIC_API_KEY: 'synthetic-auth-token' }, path)).toBe(route)
  expect(existsSync(path)).toBe(false)
})

test('an invalid registered route refuses instead of falling back to credentials', () => {
  const path = tokenPath()
  routeLookup.mockImplementation(() => routeFingerprint({} as capacity.ClaudeCapacityPin))
  for (const env of [undefined, { ANTHROPIC_API_KEY: 'synthetic-auth-token' }]) {
    expect(() => authFingerprintFor(env, path)).toThrow(capacity.NativeRelayUnavailable)
  }
  expect(existsSync(path)).toBe(false)
})
